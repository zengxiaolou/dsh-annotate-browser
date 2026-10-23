/**
 * 标注浏览器的服务层：只管「连哪台 Chrome、怎么截图、坐标落到哪个元素」。
 * 不依赖任何第三方浏览器插件；默认从 ego 的 browser.json 里取 wsUrl，
 * 也可以显式给一个 CDP 端点（比如自己启动的 Chrome --remote-debugging-port）。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "./cdp.js";
import { launchChrome, stopChrome, defaultProfileDir } from "./launcher.js";

export const DEFAULT_HOME = "https://www.deepseek.com";
const DEFAULT_BROWSER_STATE = join(homedir(), ".local/state/ego-lite-linux/browser.json");

export function readDefaultEndpoint() {
  if (!existsSync(DEFAULT_BROWSER_STATE)) return "";
  try {
    const raw = JSON.parse(readFileSync(DEFAULT_BROWSER_STATE, "utf8"));
    return typeof raw.wsUrl === "string" ? raw.wsUrl : "";
  } catch {
    return "";
  }
}

export class AnnotateBrowserService {
  constructor({ getConfig = () => ({}), log = null } = {}) {
    this.getConfig = getConfig;
    this.log = log;
    this.cdp = null;
    this.page = null;
    this.launched = null; // 我们自己拉起的 Chrome（wsUrl / pid / profileDir）
    this.lastError = "";
  }

  homeUrl() {
    const cfg = this.getConfig() || {};
    const home = typeof cfg.homeUrl === "string" ? cfg.homeUrl.trim() : "";
    return /^https?:\/\//i.test(home) ? home : DEFAULT_HOME;
  }

  endpoint() {
    const cfg = this.getConfig() || {};
    const configured = typeof cfg.wsUrl === "string" ? cfg.wsUrl.trim() : "";
    if (configured) return configured;
    return readDefaultEndpoint();
  }

  /** 没有现成端点时自己拉一台 Chrome（可在设置里关掉 autoLaunch）。 */
  async ensureEndpoint() {
    const wsUrl = this.endpoint();
    if (wsUrl) return wsUrl;
    const cfg = this.getConfig() || {};
    if (cfg.autoLaunch === false) throw new Error("没有可用的 CDP 端点，且设置里关闭了自动启动（autoLaunch=false）");
    if (this.launched) return this.launched.wsUrl;
    const launched = await launchChrome({
      chromePath: typeof cfg.chromePath === "string" ? cfg.chromePath : "",
      profileDir: typeof cfg.profileDir === "string" && cfg.profileDir.trim() ? cfg.profileDir.trim() : defaultProfileDir(),
      headless: cfg.headless !== false
    });
    this.launched = launched;
    if (this.log && typeof this.log.info === "function") this.log.info(`[annotate-browser] launched chrome ${launched.wsUrl}`);
    return launched.wsUrl;
  }

  async ensure() {
    const wsUrl = await this.ensureEndpoint();
    // 同一个端点：优先复用「我们自己那一页」——绝不去抢别人的标签页
    if (this.cdp && this.cdp.wsUrl === wsUrl && this.page) {
      try {
        const pages = await this.cdp.listPages();
        const cur = pages.find((p) => p.targetId === this.page.targetId);
        if (cur) {
          this.page = { ...this.page, url: cur.url, title: cur.title };
          if (!cur.url || cur.url === "about:blank") await this.openHome();
          return this.page;
        }
      } catch {}
    }
    if (!this.cdp || this.cdp.wsUrl !== wsUrl) {
      this.close();
      const cdp = new CdpClient(wsUrl, { timeoutMs: 8000 });
      await cdp.connect();
      this.cdp = cdp;
    }
    // 没有自己的页（首次 / 页面被关掉）→ 自己开一个，并打开配置的首页
    this.page = await this.cdp.createPage("about:blank");
    await this.openHome();
    return this.page;
  }

  /** 把当前页导航到配置的首页（默认 DeepSeek 官网）。 */
  async openHome() {
    const page = this.page;
    if (!page) return;
    try {
      await this.cdp.send("Page.enable", {}, page.sessionId);
      await this.cdp.send("Page.navigate", { url: this.homeUrl() }, page.sessionId);
      await new Promise((r) => setTimeout(r, 1500));
      const info = await this.cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify({u:location.href,t:document.title})",
        returnByValue: true
      }, page.sessionId);
      const parsed = JSON.parse(info.result.value || "{}");
      this.page = { ...page, url: parsed.u || this.homeUrl(), title: parsed.t || "" };
    } catch {}
  }

  async status() {
    try {
      const page = await this.ensure();
      return { ok: true, wsUrl: this.endpoint(), page: { url: page.url, title: page.title }, lastError: "" };
    } catch (error) {
      this.lastError = String(error?.message || error);
      return { ok: false, wsUrl: this.endpoint(), page: null, lastError: this.lastError };
    }
  }

  async shot({ format = "jpeg", quality = 80 } = {}) {
    const page = await this.ensure();
    return { page, data: await this.cdp.screenshot(page.sessionId, { format, quality }) };
  }

  async goto(url) {
    const page = await this.ensure();
    try { await this.cdp.send("Page.enable", {}, page.sessionId); } catch {}
    await this.cdp.send("Page.navigate", { url }, page.sessionId);
    await new Promise((r) => setTimeout(r, 1200));
    let url2 = url;
    let title = "";
    try {
      const info = await this.cdp.send("Runtime.evaluate", { expression: "JSON.stringify({u:location.href,t:document.title})", returnByValue: true }, page.sessionId);
      const parsed = JSON.parse(info.result.value || "{}");
      url2 = parsed.u || url;
      title = parsed.t || "";
    } catch {}
    this.page = { ...page, url: url2, title };
    return this.page;
  }

  /**
   * 开启 screencast：Chrome 只在画面变化时推帧，省掉每帧 53ms 的整帧截图。
   * 注意必须 Page.bringToFront —— 后台标签不合成，推 0 帧（实测）。
   */
  async startStream({ fps = 15, quality = 62, maxWidth = 1000 } = {}) {
    const page = await this.ensure();
    if (this._streaming && this._streamPageId === page.targetId) return { ok: true, already: true };
    await this.stopStream();
    try {
      await this.cdp.send("Page.enable", {}, page.sessionId);
      await this.cdp.send("Page.bringToFront", {}, page.sessionId).catch(() => {});
    } catch {}
    const minGap = Math.max(30, Math.round(1000 / Math.max(1, fps)));
    let lastAt = 0;
    this._latestFrame = null;
    this._frameSeq = 0;
    this._offFrame = this.cdp.on("Page.screencastFrame", (params, sessionId) => {
      if (sessionId !== page.sessionId) return;
      // 背压：立刻 ack 让 Chrome 继续画，但我们只在间隔够时替换“最新帧”（旧帧直接丢）
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, page.sessionId).catch(() => {});
      const now = Date.now();
      if (now - lastAt < minGap) return;
      lastAt = now;
      this._latestFrame = params.data;
      this._frameSeq += 1;
      for (const fn of this._frameWaiters || []) { try { fn(params.data); } catch {} }
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality,
      maxWidth,
      maxHeight: 4000,
      everyNthFrame: 1
    }, page.sessionId);
    this._streaming = true;
    this._streamPageId = page.targetId;
    return { ok: true };
  }

  async stopStream() {
    const page = this.page;
    try { this._offFrame && this._offFrame(); } catch {}
    this._offFrame = null;
    this._streaming = false;
    this._latestFrame = null;
    this._frameWaiters = [];
    if (page) { try { await this.cdp.send("Page.stopScreencast", {}, page.sessionId); } catch {} }
  }

  /** SSE 订阅：新帧到了就回调。 */
  onFrame(fn) {
    if (!this._frameWaiters) this._frameWaiters = [];
    this._frameWaiters.push(fn);
    return () => { this._frameWaiters = (this._frameWaiters || []).filter((f) => f !== fn); };
  }

  get frame() { return this._latestFrame; }

  /** DevTools 式高亮：白框 + 元素浮层，和点选共用穿透规则（跳过全屏遮罩）。 */
  async hover(x, y) {
    const page = await this.ensure();
    const out = await this.cdp.highlightAt(page.sessionId, Number(x), Number(y));
    return { ok: true, ...out };
  }

  async hideHover() {
    try {
      const page = await this.ensure();
      await this.cdp.hideHighlight(page.sessionId);
    } catch {}
    return { ok: true };
  }

  /** 把远端页面视口设成面板实际尺寸（避免 1280 宽的桌面页在窄侧栏里缩成一条黑边）。 */
  async setViewport(width, height, dpr = 1) {
    const page = await this.ensure();
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!(w >= 240 && w <= 4000 && h >= 240 && h <= 4000)) return { ok: false, error: "viewport 尺寸越界" };
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      // 固定 1x：dpr=2 会让每帧截图像素翻 4 倍，1.2s 一帧直接卡死面板；1x 已经够看清
      deviceScaleFactor: 1,
      mobile: false
    }, page.sessionId);
    return { ok: true, width: w, height: h };
  }

  async clearViewport() {
    try {
      const page = await this.ensure();
      await this.cdp.send("Emulation.clearDeviceMetricsOverride", {}, page.sessionId);
    } catch {}
  }

  /** 历史前进/后退/刷新（走 CDP，不是假按钮）。 */
  async nav(action) {
    const page = await this.ensure();
    const sid = page.sessionId;
    try { await this.cdp.send("Page.enable", {}, sid); } catch {}
    if (action === "reload") {
      await this.cdp.send("Page.reload", {}, sid);
    } else {
      const hist = await this.cdp.send("Page.getNavigationHistory", {}, sid);
      const idx = hist.currentIndex;
      const target = action === "back" ? idx - 1 : action === "forward" ? idx + 1 : -1;
      if (target < 0 || target >= (hist.entries || []).length) return { moved: false, url: page.url };
      await this.cdp.send("Page.navigateToHistoryEntry", { entryId: hist.entries[target].id }, sid);
    }
    await new Promise((r) => setTimeout(r, 900));
    try {
      const info = await this.cdp.send("Runtime.evaluate", { expression: "JSON.stringify({u:location.href,t:document.title})", returnByValue: true }, page.sessionId);
      const parsed = JSON.parse(info.result.value || "{}");
      this.page = { ...page, url: parsed.u || page.url, title: parsed.t || "" };
    } catch {}
    return { moved: true, url: this.page.url };
  }

  async elementAt(x, y) {
    const page = await this.ensure();
    return this.cdp.elementAt(page.sessionId, x, y);
  }

  close() {
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.page = null;
  }

  /** 停掉我们自己拉起的那台 Chrome（外部端点不动）。 */
  async shutdown() {
    const launched = this.launched;
    this.launched = null;
    this.close();
    if (launched) await stopChrome(launched.wsUrl, launched.pid).catch(() => {});
  }

  /** 供设置页/状态接口展示。 */
  info() {
    return {
      endpoint: this.endpoint(),
      launched: this.launched ? { wsUrl: this.launched.wsUrl, pid: this.launched.pid, profileDir: this.launched.profileDir } : null,
      lastError: this.lastError
    };
  }
}

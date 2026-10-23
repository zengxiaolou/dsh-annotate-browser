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
    if (this.cdp && this.page && this.cdp.wsUrl === wsUrl) return this.page;
    this.close();
    const cdp = new CdpClient(wsUrl, { timeoutMs: 8000 });
    await cdp.connect();
    this.page = await cdp.attachPage({ createUrl: "about:blank" });
    this.cdp = cdp;
    return this.page;
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
    const fresh = await this.cdp.attachPage({ matchUrl: "" }).catch(() => page);
    this.page = fresh;
    return fresh;
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

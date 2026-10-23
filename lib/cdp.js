/**
 * 极简 CDP 客户端：只用 Node 22+ 的全局 WebSocket，零依赖。
 * 浏览器端（browser 级）连接 + 每页一个扁平会话（flatten sessionId）。
 */
export class CdpClient {
  constructor(wsUrl, { timeoutMs = 8000 } = {}) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    if (this.ws) return this;
    if (typeof WebSocket !== "function") throw new Error("全局 WebSocket 不可用（需要 Node 22+）");
    const ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 连接超时: ${this.wsUrl}`)), this.timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`CDP 连接失败: ${this.wsUrl}`)); }, { once: true });
    });
    ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    this.ws = ws;
    return this;
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : String(raw)); } catch { return; }
    if (msg.id == null) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(`${msg.error.message || "CDP error"} (${msg.error.code})`));
    else entry.resolve(msg.result);
  }

  send(method, params = {}, sessionId = undefined) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("CDP 未连接");
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** 附到一个 page target，返回 flatten 后的 sessionId。 */
  async attachPage({ matchUrl = "", createUrl = "about:blank" } = {}) {
    const listPages = async () => {
      const { targetInfos = [] } = await this.send("Target.getTargets");
      return targetInfos.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
    };
    let pages = await listPages();
    // 无头/`--no-startup-window` 启动的 Chrome 可能一个页面都没有：自己开一个
    if (pages.length === 0) {
      await this.send("Target.createTarget", { url: createUrl });
      pages = await listPages();
    }
    const target = (matchUrl && pages.find((t) => t.url.includes(matchUrl))) || pages[0];
    if (!target) throw new Error("没有可用的页面 target（createTarget 后仍为空）");
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    return { sessionId, targetId: target.targetId, url: target.url, title: target.title };
  }

  /** 列出所有 page target（不附着）。 */
  async listPages() {
    const { targetInfos = [] } = await this.send("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
  }

  /** 自己开一个新页面并附着（插件独占，不去抢用户/别的插件的标签页）。 */
  async createPage(url = "about:blank") {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return { sessionId, targetId, url, title: "" };
  }

  /** 附着一个已存在的 target（重连时用）。 */
  async attachTarget(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return { sessionId, targetId };
  }

  /**
   * 坐标 → 元素。用 elementsFromPoint 拿整条命中栈，跳过“全屏透明遮罩”这类容器，
   * 选第一个有内容/可交互/尺寸合理的元素（DOM.getNodeForLocation 只给最顶层，遇到遮罩就废）。
   */
  async elementAt(sessionId, x, y) {
    try { await this.send("DOM.enable", {}, sessionId); } catch {}
    const expr = `(() => {
      const x = ${Number(x)}, y = ${Number(y)};
      const stack = (document.elementsFromPoint(x, y) || []).filter(Boolean);
      const vw = window.innerWidth || 1, vh = window.innerHeight || 1, vArea = vw * vh;
      const info = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const area = Math.max(0, r.width) * Math.max(0, r.height);
        const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        const interactive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)$/.test(el.tagName) || el.getAttribute("role") === "button";
        const positioned = cs.position === "absolute" || cs.position === "fixed";
        const coversAll = area >= vArea * 0.5;
        const overlay = positioned && coversAll && !interactive && text.length === 0;
        const skip = overlay || (coversAll && !interactive && text.length === 0);
        return { tag: el.tagName, id: el.id || "", cls: el.className ? String(el.className).slice(0, 60) : "",
          text: text.slice(0, 80), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          skip, interactive };
      };
      let chosen = null;
      for (const el of stack) {
        if (el.tagName === "HTML" || el.tagName === "BODY") continue;
        const i = info(el);
        if (!i.skip) { chosen = el; break; }
      }
      if (!chosen) chosen = stack.find((e) => !["HTML", "BODY"].includes(e.tagName)) || document.body;
      const i = info(chosen);
      return JSON.stringify({
        tag: i.tag, id: i.id, cls: i.cls, text: i.text, rect: i.rect,
        interactive: i.interactive,
        pageUrl: location.href, pageTitle: document.title
      });
    })()`;
    const res = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false }, sessionId);
    const value = res && res.result && res.result.value;
    if (!value) throw new Error("元素解析失败：页面没有返回结果");
    return JSON.parse(value);
  }

  /** 截图：默认 optimizeForSpeed，代价明显低于整帧高质量编码。 */
  async screenshot(sessionId, { format = "png", quality, optimizeForSpeed = true } = {}) {
    const args = { format, optimizeForSpeed };
    if (format === "jpeg" && quality) args.quality = quality;
    const { data } = await this.send("Page.captureScreenshot", args, sessionId);
    return data;
  }

  close() {
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
  }
}

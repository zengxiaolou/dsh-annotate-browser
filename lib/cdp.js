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

  async screenshot(sessionId, { format = "png", quality } = {}) {
    const args = { format };
    if (format === "jpeg" && quality) args.quality = quality;
    const { data } = await this.send("Page.captureScreenshot", args, sessionId);
    return data;
  }

  /** 坐标 → 元素（screenshot 同尺寸坐标），返回标签/文本/尺寸/选择器线索。 */
  async elementAt(sessionId, x, y) {
    try { await this.send("DOM.enable", {}, sessionId); } catch {}
    const { backendNodeId } = await this.send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false }, sessionId);
    const { object } = await this.send("DOM.resolveNode", { backendNodeId }, sessionId);
    // 注意：callFunctionOn 要的是「函数声明」，传 IIFE 会拿到 undefined
    const expr = `function () { var el = this; var r = el.getBoundingClientRect();
      var pick = function (a) { return a ? String(a).trim().slice(0, 60) : ""; };
      return JSON.stringify({ tag: el.tagName, id: el.id || "", cls: pick(el.className),
        text: pick(el.innerText || el.value || el.getAttribute("aria-label") || ""),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        pageUrl: location.href, pageTitle: document.title }); }`;
    const res = await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: expr,
      returnByValue: true
    }, sessionId);
    return { backendNodeId, ...JSON.parse(res.result.value) };
  }

  close() {
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
  }
}

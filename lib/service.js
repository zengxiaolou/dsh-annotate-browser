/**
 * 标注浏览器的服务层：只管「连哪台 Chrome、怎么截图、坐标落到哪个元素」。
 * 不依赖任何第三方浏览器插件；默认从 ego 的 browser.json 里取 wsUrl，
 * 也可以显式给一个 CDP 端点（比如自己启动的 Chrome --remote-debugging-port）。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "./cdp.js";

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
    this.lastError = "";
  }

  endpoint() {
    const cfg = this.getConfig() || {};
    const configured = typeof cfg.wsUrl === "string" ? cfg.wsUrl.trim() : "";
    if (configured) return configured;
    return readDefaultEndpoint();
  }

  async ensure() {
    const wsUrl = this.endpoint();
    if (!wsUrl) throw new Error("没有可用的 CDP 端点：插件设置里填 wsUrl，或先让一台 Chrome 以调试端口启动");
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
}

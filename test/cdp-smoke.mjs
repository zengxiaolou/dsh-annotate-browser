/**
 * 冒烟测试：直接连本机运行中的 Chrome（CDP），截图 + 坐标取元素。
 * 不依赖 dsh-browser-cdp 插件，验证我们自己的 CDP 层能独立工作。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "../lib/cdp.js";

const statePath = join(homedir(), ".local/state/ego-lite-linux/browser.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const cdp = new CdpClient(state.wsUrl);
await cdp.connect();
const page = await cdp.attachPage({ createUrl: "https://www.wikipedia.org" });
try { await cdp.send("Page.enable", {}, page.sessionId); } catch {}
await new Promise((r) => setTimeout(r, 1500));
const b64 = await cdp.screenshot(page.sessionId, { format: "jpeg", quality: 70 });
const out = "/tmp/ab-shot.jpg";
writeFileSync(out, Buffer.from(b64, "base64"));
const el = await cdp.elementAt(page.sessionId, Number(process.argv[2] || 200), Number(process.argv[3] || 150));
console.log(JSON.stringify({
  page: { url: page.url, title: page.title },
  shotBytes: Buffer.from(b64, "base64").length,
  wroteTo: out,
  element: el
}, null, 1));
cdp.close();

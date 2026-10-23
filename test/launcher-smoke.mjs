/** 验证：自己启动 Chrome → 连上 → 截图 → 取元素 → 优雅关闭（全程不依赖第三方插件）。 */
import { writeFileSync } from "node:fs";
import { launchChrome, stopChrome } from "../lib/launcher.js";
import { CdpClient } from "../lib/cdp.js";

const launched = await launchChrome({ headless: true });
const cdp = new CdpClient(launched.wsUrl);
await cdp.connect();
const page = await cdp.attachPage({ createUrl: "https://www.wikipedia.org" });
try { await cdp.send("Page.enable", {}, page.sessionId); } catch {}
await new Promise((r) => setTimeout(r, 1800));
const b64 = await cdp.screenshot(page.sessionId, { format: "jpeg", quality: 75 });
writeFileSync("/tmp/ab-launch-shot.jpg", Buffer.from(b64, "base64"));
const el = await cdp.elementAt(page.sessionId, 200, 200);
console.log(JSON.stringify({
  reused: launched.reused,
  wsUrl: launched.wsUrl,
  profileDir: launched.profileDir,
  pageUrl: page.url,
  shotBytes: Buffer.from(b64, "base64").length,
  element: { tag: el.tag, id: el.id, text: el.text, rect: el.rect }
}, null, 1));
cdp.close();
await stopChrome(launched.wsUrl, launched.pid);

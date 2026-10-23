/**
 * 用 CDP 给预览台拍图（需要 node 22+：依赖全局 WebSocket；复用插件自带的 lib/cdp.js）。
 *   node test/preview/shoot.mjs  →  test/preview/shots/*.png
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../../lib/cdp.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const CHROME =
  process.env.CHROME_PATH ||
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p)) ||
  "google-chrome";
const PORT = 9333;
const OUT = join(HERE, "shots");
const BASE = process.env.PREVIEW_URL || "http://127.0.0.1:7788/harness.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOTS = [
  { name: "360-ready", w: 360, h: 780, state: "ready" },
  { name: "360-picked", w: 360, h: 780, state: "picked" },
  { name: "360-typing", w: 360, h: 780, state: "typing" },
  { name: "360-blank", w: 360, h: 780, state: "blank" },
  { name: "360-loading", w: 360, h: 780, state: "loading" },
  { name: "360-error", w: 360, h: 780, state: "error" },
  { name: "360-shoterr", w: 360, h: 780, state: "shoterr" },
  { name: "360-insert", w: 360, h: 780, state: "insert" },
  { name: "700-ready", w: 700, h: 900, state: "ready" },
  { name: "700-picked", w: 700, h: 900, state: "picked" },
  { name: "700-typing", w: 700, h: 900, state: "typing" },
  { name: "360-hover", w: 360, h: 780, state: "ready", hover: ".ab-toggle" },
  { name: "520-ready-picked", w: 520, h: 800, state: "picked" },
  { name: "360-tall-picked", w: 360, h: 780, state: "tallpicked" }
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${join(HERE, ".chrome-profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--disable-gpu",
      "--force-device-scale-factor=1",
      "about:blank"
    ],
    { stdio: "ignore" }
  );

  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      version = await r.json();
      break;
    } catch (e) {
      await sleep(250);
    }
  }
  if (!version) throw new Error("Chrome 没起来");
  console.log("chrome:", version.Browser);

  const client = new CdpClient(version.webSocketDebuggerUrl, { timeoutMs: 20000 });
  await client.connect();
  const page = await client.attachPage({ createUrl: "about:blank" });
  const sid = page.sessionId;
  await client.send("Page.enable", {}, sid);
  await client.send("Runtime.enable", {}, sid);

  for (const shot of SHOTS) {
    await client.send(
      "Emulation.setDeviceMetricsOverride",
      { width: shot.w, height: shot.h, deviceScaleFactor: 2, mobile: false },
      sid
    );
    const url = `${BASE}?state=${shot.state}&w=${shot.w}&h=${shot.h}`;
    await client.send("Page.navigate", { url }, sid);
    // 等 __ready
    let ready = false;
    for (let i = 0; i < 120; i += 1) {
      await sleep(100);
      try {
        const r = await client.send(
          "Runtime.evaluate",
          { expression: "window.__ready === true", returnByValue: true },
          sid
        );
        if (r.result && r.result.value === true) {
          ready = true;
          break;
        }
      } catch (e) {
        /* 导航中上下文被销毁，重试 */
      }
    }
    if (!ready) console.log(`  ! ${shot.name} 超时未 ready`);
    await sleep(350);

    if (shot.hover) {
      const box = await client.send(
        "Runtime.evaluate",
        {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(shot.hover)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
          returnByValue: true
        },
        sid
      );
      const pt = box.result && box.result.value;
      if (pt) {
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, buttons: 0 }, sid);
        await sleep(260);
      }
    }

    const metrics = await client.send(
      "Runtime.evaluate",
      { expression: "JSON.stringify(window.__insert || window.__metrics || null)", returnByValue: true },
      sid
    );

    const png = await client.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      sid
    );
    writeFileSync(`${OUT}/${shot.name}.png`, Buffer.from(png.data, "base64"));
    console.log(`  ✓ ${shot.name}  ${metrics.result ? metrics.result.value : ""}`);
  }

  client.close();
  chrome.kill("SIGTERM");
  await sleep(300);
  console.log("done →", OUT);
}

main().catch(async (e) => {
  console.error("FAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});

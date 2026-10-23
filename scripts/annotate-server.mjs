#!/usr/bin/env node
/**
 * 标注浏览器后端：启动 / 自检 / 停止。
 *
 *   node scripts/annotate-server.mjs           # 自检（连已有端点，打印页面与截图）
 *   node scripts/annotate-server.mjs start     # 没有端点就拉起一台 Chrome，并打开首页
 *   node scripts/annotate-server.mjs stop      # 关闭「本脚本拉起的」Chrome（外部端点不动）
 *
 * 说明：DSH 面板走的是同一套 lib/，这里只是给人用的命令行入口，不经过 DSH 的 web 鉴权。
 */
import { homedir } from "node:os";
import { CdpClient } from "../lib/cdp.js";
import { readDefaultEndpoint } from "../lib/service.js";

const HOME = process.env.ANNOTATE_HOME_URL || "https://www.deepseek.com";
const cmd = (process.argv[2] || "status").toLowerCase();

async function resolveEndpoint({ launch }) {
  let ep = readDefaultEndpoint();
  if (!ep && launch) {
    const { launchChrome } = await import("../lib/launcher.js");
    const out = await launchChrome({ headless: true });
    ep = out.wsUrl;
    console.log("已拉起 Chrome:", ep);
    console.log("停止命令: node scripts/annotate-server.mjs stop");
  }
  return ep;
}

async function status() {
  const ep = await resolveEndpoint({ launch: false });
  if (!ep) {
    console.log("未发现 CDP 端点。用 `node scripts/annotate-server.mjs start` 启动一台。");
    process.exit(2);
  }
  const c = new CdpClient(ep, { timeoutMs: 8000 });
  await c.connect();
  const pages = await c.listPages();
  console.log("端点:", ep);
  console.log("页面:", pages.length);
  for (const p of pages) console.log("  -", String(p.url).slice(0, 60), "|", String(p.title || "").slice(0, 24));
  if (!pages.length) {
    console.log("没有页面，正在新建…");
    const page = await c.createPage(HOME);
    await new Promise((r) => setTimeout(r, 1200));
    console.log("已新建:", String(page.url));
    c.close();
    return;
  }
  const target = pages[0];
  const a = await c.attachTarget(target.targetId);
  const t0 = Date.now();
  const b64 = await c.screenshot(a.sessionId, { format: "jpeg", quality: 72 });
  const kb = Math.round(Buffer.from(b64, "base64").length / 1024);
  console.log(`截图: ${kb}KB / ${Date.now() - t0}ms`);
  try {
    const el = await c.elementAt(a.sessionId, 420, 330);
    console.log("取元素:", el.tag, "|", String(el.text || "").slice(0, 30).replace(/\s+/g, " "));
  } catch (e) {
    console.log("取元素失败:", e.message);
  }
  c.close();
}

async function stop() {
  const ep = readDefaultEndpoint();
  if (!ep) { console.log("没有端点，无需停止。"); return; }
  const state = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(
    `${homedir()}/.local/state/ego-lite-linux/browser.json`, "utf8")));
  const { stopChrome } = await import("../lib/launcher.js");
  await stopChrome(ep, state.pid);
  console.log("已请求关闭:", state.pid);
}

try {
  if (cmd === "start") { const ep = await resolveEndpoint({ launch: true }); console.log("就绪:", ep); }
  else if (cmd === "stop") await stop();
  else await status();
} catch (e) {
  console.error("失败:", e.message);
  process.exit(1);
}

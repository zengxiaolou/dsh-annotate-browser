/**
 * 自己启动/管理一台 Chrome（不依赖任何第三方插件）。
 * 思路：--remote-debugging-port=0 + 独立 profile 目录，读 DevToolsActivePort 拿到端口与 ws 路径。
 * 无头优先（不打扰桌面）；需要人工拖滑块时可把 headless 关掉。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable"
];

export function findChrome(configured = "") {
  if (configured && existsSync(configured)) return configured;
  return CHROME_CANDIDATES.find((p) => existsSync(p)) || "";
}

export function defaultProfileDir() {
  return join(homedir(), ".local/share/dsh-annotate-browser/profile");
}

/**
 * 启动一台 Chrome 并返回 { wsUrl, httpUrl, pid, profileDir }。
 * 已有同 profile 的实例在跑时，直接复用（读它写下的 DevToolsActivePort）。
 */
export async function launchChrome({
  chromePath = "",
  profileDir = defaultProfileDir(),
  headless = true,
  timeoutMs = 20000,
  extraArgs = []
} = {}) {
  const bin = findChrome(chromePath);
  if (!bin) throw new Error("找不到 Chrome，可在设置里填 chromePath");
  mkdirSync(profileDir, { recursive: true });
  const portFile = join(profileDir, "DevToolsActivePort");

  const readPort = () => {
    if (!existsSync(portFile)) return null;
    const lines = readFileSync(portFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    const port = Number(lines[0]);
    if (!port) return null;
    return { port, wsPath: lines[1] || `/devtools/browser` };
  };

  const existing = readPort();
  if (existing) {
    // 端口还在监听就当作可复用
    const alive = await probe(`http://127.0.0.1:${existing.port}/json/version`);
    if (alive) {
      return {
        wsUrl: `ws://127.0.0.1:${existing.port}${existing.wsPath}`,
        httpUrl: `http://127.0.0.1:${existing.port}`,
        pid: 0,
        profileDir,
        reused: true
      };
    }
  }

  rmSync(portFile, { force: true });
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--remote-allow-origins=*",
    "--window-size=1280,900",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-startup-window",
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs
  ];
  const child = spawn(bin, args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = readPort();
    if (got) {
      const httpUrl = `http://127.0.0.1:${got.port}`;
      if (await probe(`${httpUrl}/json/version`)) {
        return { wsUrl: `ws://127.0.0.1:${got.port}${got.wsPath}`, httpUrl, pid: child.pid, profileDir, reused: false };
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  try { process.kill(child.pid, "SIGTERM"); } catch {}
  throw new Error(`Chrome 未在 ${timeoutMs}ms 内暴露调试端口（profile: ${profileDir}）`);
}

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 优雅关闭：先 Browser.close，再补 SIGTERM。 */
export async function stopChrome(wsUrl, pid) {
  try {
    if (wsUrl && typeof WebSocket === "function") {
      const ws = new WebSocket(wsUrl);
      await new Promise((resolve) => {
        const done = () => resolve();
        ws.addEventListener("open", () => { try { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); } catch {} setTimeout(done, 300); }, { once: true });
        ws.addEventListener("error", done, { once: true });
        setTimeout(done, 1500);
      });
    }
  } catch {}
  try { if (pid) process.kill(pid, "SIGTERM"); } catch {}
}

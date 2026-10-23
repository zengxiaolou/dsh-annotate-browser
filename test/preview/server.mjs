/**
 * 面板预览台：mock 后端 + 静态服务。
 *
 * 目的：不启动 DSH、不驱动真实浏览器，也能看到 lib/client.js 的完整界面
 * （五种状态 / 两种宽度 / 浮卡 / 插入后反馈），用于改样式前后对比。
 *
 *   node test/preview/server.mjs          # http://127.0.0.1:7788/harness.html
 *   node test/preview/shoot.mjs           # 用 CDP 批量截图到 test/preview/shots/
 *
 * vendor/ 里需要 React 18 的 UMD（未入库，见 README）。
 */
import http from "node:http";
import { readFileSync, createReadStream, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const VENDOR = join(HERE, "vendor");
const PORT = Number(process.env.PORT || 7788);

const CLIENT = join(REPO, "lib/client.js");
const SHOT = join(HERE, "fixture-page.svg");
const TALL = join(HERE, "fixture-page-tall.svg");

let state = "ready";
let shotCount = 0;

const PAGE = {
  url: "https://checkout.example.com/pay/confirm?order=20261023A7",
  title: "确认订单 - 示例商城"
};

const ELEMENT = {
  tag: "BUTTON",
  id: "submit",
  cls: "btn btn-primary btn-block",
  text: "确认支付 ￥ 1,280.00",
  rect: { x: 152, y: 536, w: 576, h: 44 },
  pageUrl: PAGE.url,
  pageTitle: PAGE.title,
  backendNodeId: 42
};

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": buf.length
  });
  res.end(buf);
}

function sendImage(res, file) {
  const src = file || SHOT;
  const stat = statSync(src);
  res.writeHead(200, {
    "content-type": "image/svg+xml",
    "cache-control": "no-store",
    "content-length": stat.size
  });
  createReadStream(src).pipe(res);
}

function sendFile(res, path, type) {
  if (!existsSync(path)) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`缺少 ${path}\n见 test/preview/README.md 的 vendor 说明`);
    return;
  }
  const body = readFileSync(path);
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-length": body.length });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;

  if (p === "/__state") {
    state = u.searchParams.get("value") || "ready";
    shotCount = 0;
    return json(res, 200, { ok: true, state });
  }

  if (p === "/api/annotate-browser/status") {
    const config = { pollMs: 1200, quality: 82, headless: true };
    const base = {
      wsUrl: "ws://127.0.0.1:9222/devtools/browser/preview",
      info: { endpoint: "ws://127.0.0.1:9222/devtools/browser/preview", launched: null, lastError: "" },
      config
    };
    if (state === "loading") return; // 永不返回：模拟首次拉起 Chrome
    if (state === "error") {
      return json(res, 200, {
        ...base,
        ok: false,
        page: null,
        lastError: "CDP 连接失败: ws://127.0.0.1:9222/devtools/browser/preview (ECONNREFUSED)"
      });
    }
    if (state === "blank") {
      return json(res, 200, { ...base, ok: true, page: { url: "about:blank", title: "" }, lastError: "" });
    }
    return json(res, 200, { ...base, ok: true, page: PAGE, lastError: "" });
  }

  if (p === "/api/annotate-browser/shot") {
    shotCount += 1;
    if (state === "shoterr" && shotCount > 1) {
      return json(res, 503, { ok: false, error: "CDP 调用超时: Page.captureScreenshot" });
    }
    if (state === "loading" || state === "error") {
      return json(res, 503, { ok: false, error: "没有可用的页面" });
    }
    if (state === "tall" || state === "tallpicked") return sendImage(res, TALL);
    return sendImage(res);
  }

  if (p === "/api/annotate-browser/element" && req.method === "POST") {
    return json(res, 200, { ok: true, element: ELEMENT });
  }
  if (p === "/api/annotate-browser/navigate" && req.method === "POST") {
    return json(res, 200, { ok: true, page: PAGE });
  }
  if (p === "/api/annotate-browser/nav" && req.method === "POST") {
    return json(res, 200, { ok: true, moved: true, url: PAGE.url });
  }
  if (p === "/api/annotate-browser/start" && req.method === "POST") {
    return json(res, 200, { ok: true, ...PAGE, lastError: "" });
  }

  if (p === "/harness.html") return sendFile(res, join(HERE, "harness.html"), "text/html; charset=utf-8");
  if (p === "/client.js") return sendFile(res, CLIENT, "application/javascript; charset=utf-8");
  if (p === "/vendor/react.js") {
    return sendFile(res, join(VENDOR, "react.development.js"), "application/javascript; charset=utf-8");
  }
  if (p === "/vendor/react-dom.js") {
    return sendFile(res, join(VENDOR, "react-dom.development.js"), "application/javascript; charset=utf-8");
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found: " + p);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[preview] http://127.0.0.1:${PORT}/harness.html`);
  console.log(`[preview] client = ${CLIENT}`);
});

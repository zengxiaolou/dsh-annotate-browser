/**
 * dsh-annotate-browser 的宿主半。
 * - 提供本地路由给客户端面板（状态/截图/取元素/导航/停止）
 * - 没有任何现成浏览器时，自己拉起一台 Chrome（lib/launcher.js）
 * - 配置项走 DSH 的设置分区（Schemastery），也可直接用 cordis.patch.yml 的 config 段
 */
import { createRequire } from "node:module";
import { AnnotateBrowserService } from "./service.js";

export const inject = ["webServer"];
export const SETTINGS_NS = "dsh-annotate-browser";

export const ROUTES = {
  status: "/api/annotate-browser/status",
  shot: "/api/annotate-browser/shot",
  element: "/api/annotate-browser/element",
  navigate: "/api/annotate-browser/navigate",
  stop: "/api/annotate-browser/stop",
  start: "/api/annotate-browser/start",
  nav: "/api/annotate-browser/nav",
  viewport: "/api/annotate-browser/viewport",
  hover: "/api/annotate-browser/hover",
  stream: "/api/annotate-browser/stream",
  mark: "/api/annotate-browser/mark",
  marksClear: "/api/annotate-browser/marks/clear",
  annotations: "/api/annotate-browser/annotations",
  annotationsCount: "/api/annotate-browser/annotations/count",
  input: "/api/annotate-browser/input",
  selection: "/api/annotate-browser/selection",
  tabs: "/api/annotate-browser/tabs",
  mobile: "/api/annotate-browser/mobile",
  freeze: "/api/annotate-browser/freeze",
  crop: "/api/annotate-browser/crop",
  marksRemove: "/api/annotate-browser/marks/remove"
};

export const DEFAULTS = {
  wsUrl: "",
  chromePath: "",
  headless: true,
  autoLaunch: true,
  profileDir: "",
  pollMs: 1200,
  quality: 82,
  homeUrl: "https://www.deepseek.com",
  streamMode: "screencast",
  streamFps: 15
};

const require = createRequire(import.meta.url);

function loadSchema() {
  try {
    const mod = require("@deepseek-ai/schemastery");
    const Schema = mod?.default ?? mod;
    if (typeof Schema?.object !== "function") return null;
    return Schema.object({
      wsUrl: Schema.string().description("显式 CDP 端点（ws://127.0.0.1:port/devtools/browser/…）。留空 = 先找个现成的，再没有就自己启动一台"),
      chromePath: Schema.string().description("Chrome 可执行文件路径。留空 = 自动探测常见位置"),
      headless: Schema.boolean().default(true).description("自己启动的浏览器是否无头（关掉会弹出可见窗口）"),
      autoLaunch: Schema.boolean().default(true).description("没有现成端点时是否自动拉起一台 Chrome"),
      profileDir: Schema.string().description("浏览器 profile 目录。留空 = ~/.local/share/dsh-annotate-browser/profile"),
      pollMs: Schema.number().min(300).max(5000).step(100).default(1200).description("面板拉取画面的间隔（毫秒）"),
      quality: Schema.number().min(40).max(100).step(1).default(82).description("画面 JPEG 质量"),
      homeUrl: Schema.string().description("启动浏览器后默认打开的网址（默认 DeepSeek 官网）"),
      streamMode: Schema.string().description("画面传输：screencast（推流，推荐）或 poll（轮询截图）"),
      streamFps: Schema.number().min(5).max(30).step(1).default(15).description("推流帧率上限")
    });
  } catch {
    return null;
  }
}

function resolveConfig(source) {
  const raw = typeof source === "function" ? source() : source || {};
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined && raw[key] !== null) cfg[key] = raw[key];
  }
  if (typeof cfg.quality === "number") cfg.quality = Math.max(40, Math.min(100, Math.round(cfg.quality)));
  if (typeof cfg.pollMs === "number") cfg.pollMs = Math.max(300, Math.min(5000, Math.round(cfg.pollMs)));
  return cfg;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

export function apply(ctx, config = {}) {
  // cordis 把插件 config 作为 apply 的第二个参数传入；ctx.config 需要额外 inject，别用
  let currentConfig = resolveConfig(config || {});
  const Config = loadSchema();

  // 设置分区：装了 @deepseek-ai/dsh-settings 就能在设置页里改；没有也能用 cordis.patch.yml
  if (Config) {
    try {
      const settings = require("@deepseek-ai/dsh-settings");
      if (typeof settings.installSettingsSection === "function" && typeof settings.settingsNamespace === "function") {
        settings.installSettingsSection(ctx, settings.settingsNamespace(SETTINGS_NS), Config, currentConfig, {
          setSource: (source) => {
            currentConfig = resolveConfig(typeof source === "function" ? source() : source);
          },
          onChange: () => {
            currentConfig = resolveConfig(currentConfig);
          }
        });
      }
    } catch {}
  }

  const svc = new AnnotateBrowserService({ getConfig: () => currentConfig, log: ctx.logger });
  ctx.effect(() => () => svc.close());

  const route = (path, handler) =>
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path, handler }));

  route(ROUTES.status, async (req, res) => {
    const status = await svc.status();
    sendJson(res, 200, { ...status, info: svc.info(), config: currentConfig });
  });

  route(ROUTES.shot, async (req, res) => {
    try {
      const { page, data } = await svc.shot({ format: "jpeg", quality: currentConfig.quality });
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "x-annotate-page": encodeURIComponent(`${page.title} ${page.url}`)
      });
      res.end(Buffer.from(data, "base64"));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.element, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const element = await svc.elementAt(Number(body.x), Number(body.y));
      sendJson(res, 200, { ok: true, element });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.navigate, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      if (typeof body.url !== "string" || !/^https?:/i.test(body.url)) {
        sendJson(res, 400, { ok: false, error: "url 必须是 http(s) 地址" });
        return;
      }
      const page = await svc.goto(body.url);
      sendJson(res, 200, { ok: true, page: { url: page.url, title: page.title } });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  // SSE 推流：Chrome 有变化才推帧，比 450ms 轮询整帧截图顺得多
  route(ROUTES.selection, async (req, res) => {
    try {
      sendJson(res, 200, await svc.readSelection());
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.crop, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await svc.crop(body));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.freeze, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await svc.freeze(!!body.on));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.mobile, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await svc.setMobile(!!body.on));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.tabs, async (req, res) => {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      sendJson(res, 200, await svc.tabs(body.action || "list", body.targetId || ""));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.input, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await svc.input(body));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.annotationsCount, async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, count: svc.annotationCount(), watchers: svc.watchers });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.annotations, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await svc.appendAnnotation(body));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.mark, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await svc.addMark(body));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.marksRemove, async (req, res) => {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      sendJson(res, 200, await svc.removeMark(body.n));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.marksClear, async (req, res) => {
    try {
      sendJson(res, 200, await svc.clearMarks());
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.stream, async (req, res) => {
    if (currentConfig.streamMode === "poll") {
      sendJson(res, 409, { ok: false, error: "streamMode=poll，请用 /shot" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { off(); } catch {}
      try { res.end(); } catch {}
      // 最后一个 watcher 断开 → 真正停掉 screencast（否则 Chrome 会一直编码帧）
      svc.releaseStream().catch(() => {});
    };
    req.on("close", cleanup);
    let off = () => {};
    try {
      await svc.acquireStream({ fps: currentConfig.streamFps });
      const push = (data) => {
        if (closed) return;
        res.write(`data: ${data}\n\n`);
      };
      if (svc.frame) push(svc.frame);
      off = svc.onFrame(push);
      const keepAlive = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, 15000);
      req.on("close", () => clearInterval(keepAlive));
    } catch (error) {
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: String(error?.message || error) })}\n\n`);
      cleanup();
    }
  });

  route(ROUTES.hover, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      if (body && body.hide === true) return sendJson(res, 200, await svc.hideHover());
      sendJson(res, 200, await svc.hover(body.x, body.y));
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.viewport, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const out = await svc.setViewport(body.width, body.height, body.dpr);
      sendJson(res, out.ok ? 200 : 400, out);
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.nav, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const action = String(body.action || "");
      if (!["back", "forward", "reload"].includes(action)) {
        sendJson(res, 400, { ok: false, error: "action 只能是 back/forward/reload" });
        return;
      }
      sendJson(res, 200, { ok: true, ...(await svc.nav(action)) });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.start, async (req, res) => {
    try {
      const status = await svc.status();
      sendJson(res, 200, { ...status, info: svc.info() });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error?.message || error) });
    }
  });

  route(ROUTES.stop, async (req, res) => {
    try {
      await svc.shutdown();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) });
    }
  });
}

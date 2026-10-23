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
  viewport: "/api/annotate-browser/viewport"
};

export const DEFAULTS = {
  wsUrl: "",
  chromePath: "",
  headless: true,
  autoLaunch: true,
  profileDir: "",
  pollMs: 1200,
  quality: 82
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
      quality: Schema.number().min(40).max(100).step(1).default(82).description("画面 JPEG 质量")
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

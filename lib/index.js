/**
 * dsh-annotate-browser 的宿主半：注册本地路由，供客户端面板取图 / 取元素。
 * 刻意不注册任何模型工具——v0.1 只服务于「人在面板里标注」，工具面留到后续版本再加。
 */
import { AnnotateBrowserService } from "./service.js";

export const inject = ["webServer"];

export const ROUTES = {
  status: "/api/annotate-browser/status",
  shot: "/api/annotate-browser/shot",
  element: "/api/annotate-browser/element",
  navigate: "/api/annotate-browser/navigate"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

export function apply(ctx) {
  const svc = new AnnotateBrowserService({
    getConfig: () => (ctx.config && typeof ctx.config === "object" ? ctx.config : {}),
    log: ctx.logger
  });
  ctx.effect(() => () => svc.close());

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: ROUTES.status,
      handler: async (req, res) => {
        sendJson(res, 200, await svc.status());
      }
    })
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: ROUTES.shot,
      handler: async (req, res) => {
        try {
          const { page, data } = await svc.shot({ format: "jpeg", quality: 82 });
          res.writeHead(200, {
            "content-type": "image/jpeg",
            "cache-control": "no-store",
            "x-annotate-page": encodeURIComponent(`${page.title} ${page.url}`)
          });
          res.end(Buffer.from(data, "base64"));
        } catch (error) {
          sendJson(res, 503, { ok: false, error: String(error?.message || error) });
        }
      }
    })
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: ROUTES.element,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const element = await svc.elementAt(Number(body.x), Number(body.y));
          sendJson(res, 200, { ok: true, element });
        } catch (error) {
          sendJson(res, 503, { ok: false, error: String(error?.message || error) });
        }
      }
    })
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: ROUTES.navigate,
      handler: async (req, res) => {
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
      }
    })
  );
}

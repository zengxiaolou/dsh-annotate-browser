/** 走插件真实的服务层（lib/service.js），验证 status / shot / elementAt 三条路径。 */
import { writeFileSync } from "node:fs";
import { AnnotateBrowserService } from "../lib/service.js";

const svc = new AnnotateBrowserService({ getConfig: () => ({}) });
const out = { status: await svc.status() };
if (out.status.ok) {
  const shot = await svc.shot();
  const buf = Buffer.from(shot.data, "base64");
  writeFileSync("/tmp/ab-service-shot.jpg", buf);
  out.shotBytes = buf.length;
  out.element = await svc.elementAt(200, 150);
} else {
  out.hint = "没有运行中的 Chrome：先让浏览器以调试端口启动，或在插件设置里填 wsUrl";
}
svc.close();
console.log(JSON.stringify(out, null, 1));

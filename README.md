# dsh-annotate-browser

自己的 DSH **标注浏览器**插件：在输入框上方开一个面板，看着浏览器画面点选元素、写一句备注，注释直接落进聊天输入框。
**不依赖** `dsh-browser-cdp` 或任何第三方浏览器插件 —— CDP 客户端是本仓库自己实现的（零依赖）。

> 定位：给「人指出问题 → agent 改代码」这条链路提供一个完全自主的壳，后续功能按需要自己往上加。

## 现在能用什么（v0.1.0）

1. 输入框上方出现胶囊 **「🖱 标注浏览器」**，点开是面板；
2. 面板里是目标页面的**实时截图**（1.2s 轮询，走 `Page.captureScreenshot`）；
3. 在图上点一下 → 取到该元素（tag / id / 文本 / 矩形 / 页面标题）；
4. 写一句备注 → 「插入对话」，输入框里出现：

```text
〔标注〕button#submit「确认支付」｜页面：收银台 https://…｜备注：文案改成“确认支付”
```

## 结构

| 文件 | 职责 |
|---|---|
| `lib/cdp.js` | 零依赖 CDP 客户端（全局 WebSocket）：连接、附页、截图、坐标取元素 |
| `lib/service.js` | 端点解析（默认读 ego 的 `browser.json`，也可配 `wsUrl`）、截图/取元素/导航 |
| `lib/index.js` | 宿主插件：注册 `/api/annotate-browser/{status,shot,element,navigate}` |
| `lib/client.js` | 客户端插件：`conversation.input.dock` 上的胶囊 + 面板 |
| `test/cdp-smoke.mjs` | 只测 CDP 层（不启动 DSH） |
| `test/service-smoke.mjs` | 走服务层，验证 status/shot/elementAt |

## 安装

还没发布 npm，直接从仓库装：

```sh
dsh plugin --profile desktop add github:zengxiaolou/dsh-annotate-browser
# 或本地联调：
dsh plugin --profile desktop add file:~/Documents/study/探索/dsh-annotate-browser
```

装完重启 DSH，输入框上方应出现胶囊。

## CDP 端点

默认读 `~/.local/state/ego-lite-linux/browser.json` 的 `wsUrl`（任何用 `--remote-debugging-port` 起的 Chrome 也只要填 wsUrl）。
后续会把端点做成设置项（见 ROADMAP）。

## 已验证 / 未验证

| 项 | 状态 | 证据 |
|---|---|---|
| CDP 层：连接 / 截图 / 坐标取元素 | ✅ 已验证 | `test/cdp-smoke.mjs`：截图 6877B、`elementAt` 返回 BODY 及其矩形 |
| 服务层：status / shot / elementAt | ✅ 已验证 | `test/service-smoke.mjs`：`shotBytes:6878`、element 结构完整 |
| 无页面时自动建标签 | ✅ 已验证 | 无头 Chrome 零标签场景下 `Target.createTarget` 生效 |
| 客户端面板渲染 / 插入草稿 | ❌ 未验收 | 需要装进 DSH 并重启，当前会话不方便重启验证 |
| 设置页（wsUrl 可配） | ❌ 未实现 | 现在只能读默认 browser.json |

## ROADMAP（功能由使用中按需追加）

- [ ] 设置卡片：wsUrl / 轮询间隔 / 画质
- [ ] 多选：一次标 3～5 个元素，页面上打 1/2/3 编号，草稿里聚合成一个块
- [ ] 注释胶囊聚合（像划词注释那样只占一行，可展开编辑/删除）
- [ ] 模型工具面：`ab_open` / `ab_shot` / `ab_click` / `ab_mark`，让 agent 也能主动开页面
- [ ] 多标签切换 + 页面导航历史
- [ ] 区域截图标注（框选一块区域贴进对话）

## 许可

MIT。

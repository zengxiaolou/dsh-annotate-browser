# 架构与扩展点

## 数据流

```text
[Chrome] --CDP ws--> lib/cdp.js --+
                                  +--> lib/service.js --> lib/index.js（HTTP 路由）
[DSH 客户端] --同源 fetch--> /api/annotate-browser/* --+

[DSH 客户端] lib/client.js（conversation.input.dock 槽位）
   └─ 取图/取元素 → 组装一行注释 → inputActions.setDraft(next)
```

## 加功能的三个位置

| 想加什么 | 改哪里 | 注意 |
|---|---|---|
| 新的浏览器能力（点击/输入/滚动） | `lib/cdp.js` 加方法 → `lib/service.js` 暴露 → `lib/index.js` 加路由 | 一律复用同一页 session，别重复 attach |
| 面板 UI（多选、胶囊、缩略图） | `lib/client.js` | 草稿写入必须用 `props.inputActions.setDraft`，**不要**走 `ctx.get('conversation')` |
| 模型工具（让 agent 自己开页面） | `lib/index.js` 里注册 `ctx.tools` | v0.1 故意不做，先保证人的链路稳 |

## 已知坑（都是实际踩过的）

1. `--no-startup-window` 起的 Chrome **没有页面**，必须 `Target.createTarget` 自己开；
2. `Runtime.callFunctionOn` 要传**函数声明**，传 IIFE 拿到 undefined；
3. `DOM.getNodeForLocation` 前要 `DOM.enable`；
4. `DOM.getBoxModel` 返回**视口坐标**，画标记不要再减 `scrollY`；
5. 客户端草稿只能走 `inputActions.setDraft`；真实 composer facade 没有 `setDraft`。
6. CDP 坐标来自截图（视口像素），面板里点图要按 `naturalWidth / 显示宽度` 换算。

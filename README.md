# dsh-annotate-browser

自己的 DSH **标注浏览器**插件：在输入框上方开一个面板，看着浏览器画面点选元素、写一句备注，注释直接落进聊天输入框。
**不依赖** `dsh-browser-cdp` 或任何第三方浏览器插件 —— CDP 客户端是本仓库自己实现的（零依赖）。

> 定位：给「人指出问题 → agent 改代码」这条链路提供一个完全自主的壳，后续功能按需要自己往上加。

## 现在能用什么（v0.1.0）

1. 右侧栏多一个 tab **「标注浏览器」**，撑满侧栏；
2. 面板里是目标页面的**实时截图**（默认 1.2s 一轮，读设置里的 `pollMs`，走 `Page.captureScreenshot`）；
3. 打开工具条上的 **「标注」开关** 后，点画面里的元素 → 取到该元素（tag / id / 文本 / 矩形 / 页面标题）；
   落点会画一个圆钉，备注卡贴着它出现（`Enter` 插入 / `Esc` 取消）；
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
| `lib/client.js` | 客户端插件：右侧栏面板 + `conversation.input.dock` 上的隐藏草稿写入器 |
| `test/cdp-smoke.mjs` | 只测 CDP 层（不启动 DSH） |
| `test/service-smoke.mjs` | 走服务层，验证 status/shot/elementAt |
| `test/preview/` | 面板预览台：mock 后端 + 真 `client.js`，不启 DSH 也能看图、批量截图 |
| `docs/DESIGN.md` | 面板布局/尺寸/状态/交互的规格与理由 |

## 安装

还没发布 npm，直接从仓库装：

```sh
dsh plugin --profile desktop add github:zengxiaolou/dsh-annotate-browser
# 或本地联调：
dsh plugin --profile desktop add file:~/Documents/study/探索/dsh-annotate-browser
```

装完重启 DSH，输入框上方应出现胶囊。

## CDP 端点与自动启动（v0.2）

解析顺序：

1. 设置里的 **`wsUrl`**（显式指定）；
2. `~/.local/state/ego-lite-linux/browser.json`（有别的插件/脚本起了 Chrome 就复用）；
3. **自己拉起一台 Chrome**（`lib/launcher.js`）：`--remote-debugging-port=0` + 独立 profile（默认
   `~/.local/share/dsh-annotate-browser/profile`），读 `DevToolsActivePort` 拿 ws 地址；无头优先。

## 设置项（`dsh-annotate-browser`）

装了 `@deepseek-ai/dsh-settings` 时出现在插件设置页；也可以直接在 `cordis.patch.yml` 里写 config：

| 键 | 默认 | 说明 |
|---|---|---|
| `wsUrl` | `""` | 显式 CDP 端点；空 = 复用或自己启动 |
| `chromePath` | `""` | Chrome 路径；空 = 自动探测 |
| `headless` | `true` | 自己启动的浏览器是否无头 |
| `autoLaunch` | `true` | 没有现成端点时是否自动启动 |
| `profileDir` | `""` | 空 = `~/.local/share/dsh-annotate-browser/profile` |
| `pollMs` | `1200` | 面板拉画面间隔 |
| `quality` | `82` | 画面 JPEG 质量 |

```yaml
- id: dsh-annotate-browser
  config:
    headless: true
    pollMs: 1200
    quality: 85
```

## 路由

`/api/annotate-browser/{status,shot,element,navigate,stop}` —— `stop` 只关闭**我们自己拉起**的那台 Chrome。

## 已验证 / 未验证

| 项 | 状态 | 证据 |
|---|---|---|
| CDP 层：连接 / 截图 / 坐标取元素 | ✅ 已验证 | `test/cdp-smoke.mjs`：截图 6877B、`elementAt` 返回 BODY 及其矩形 |
| 服务层：status / shot / elementAt | ✅ 已验证 | `test/service-smoke.mjs`：`shotBytes:6878`、element 结构完整 |
| 无页面时自动建标签 | ✅ 已验证 | 无头 Chrome 零标签场景下 `Target.createTarget` 生效 |
| 自己启动 Chrome（无头）→ 截图 → 取元素 → 优雅关闭 | ✅ 已验证 | `test/launcher-smoke.mjs`：ws `:57798`、截图 63130B、element=MAIN(0,40,1265,575) |
| 设置项（wsUrl/chromePath/headless/autoLaunch/profileDir/pollMs/quality） | ✅ 代码就绪 | Schemastery 分区 + `cordis.patch.yml` 两种入口；**设置页渲染未验收** |
| 客户端面板渲染 / 插入草稿 | ❌ 未验收 | 需装进 DSH 重启后确认 |

## ROADMAP（功能由使用中按需追加）

- [x] 设置项：wsUrl / chromePath / headless / autoLaunch / profileDir / pollMs / quality
- [ ] 多选：一次标 3～5 个元素，页面上打 1/2/3 编号，草稿里聚合成一个块
- [ ] 注释胶囊聚合（像划词注释那样只占一行，可展开编辑/删除）
- [ ] 模型工具面：`ab_open` / `ab_shot` / `ab_click` / `ab_mark`，让 agent 也能主动开页面
- [ ] 多标签切换 + 页面导航历史
- [ ] 区域截图标注（框选一块区域贴进对话）

## 许可

MIT。

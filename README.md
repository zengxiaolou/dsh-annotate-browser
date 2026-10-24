# dsh-annotate-browser

![dsh-annotate-browser](https://raw.githubusercontent.com/zengxiaolou/dsh-annotate-browser/main/docs/images/promo.png)


自己的 DSH **标注浏览器**插件：右侧栏里一个**可操作的真实浏览器**（CDP 推流 + 输入转发），在上面点选元素或划选文字、写一句备注，带着源码位置/组件栈/样式/裁图落进聊天输入框。
**不依赖** `dsh-browser-cdp` 或任何第三方浏览器插件 —— CDP 客户端是本仓库自己实现的（零依赖）。

> 定位：给「人指出问题 → agent 改代码」这条链路提供一个完全自主的壳，后续功能按需要自己往上加。

## 现在能用什么（v0.2.3）

**浏览**（面板里是一个可操作的真实页面，不只是截图）

1. 右侧栏 tab「标注浏览器」，撑满侧栏、按面板尺寸 1:1 渲染（视口随宽高自适应，无黑边）；
2. 地址栏 + `← → ⟳` + 标签页（新建 / 切换 / 关闭，>1 个才显示标签条）；
3. **直接操作**：点击 / 双击 / 右键 / 拖拽 / 滚轮 / 键盘（含 Backspace、方向键、Tab），`⌘A/C/V/X/Z` 放行给页面；
4. 画面走 **CDP screencast 推流**（只在画面变化时推，15fps 上限），断线自动退回 450ms 轮询；
5. 「⋯」菜单里：设备宽度 390/768/1280、移动端模拟（触屏 + iPhone UA + 390×800@2x）。

**标注**

6. `⌘I` 开标注 → 鼠标悬停即出现 **DevTools 式高亮**（白框 + tag/尺寸/AX 信息，`Overlay.highlightNode`）；
7. 点元素选中（会**穿透全屏透明遮罩**，取真正被点到的元素），页面留下 **编号钉 + 蓝框**；
8. 拖拽 = 在页面里**真实选中文字**，以选区文本作为标注对象；
9. **多选**：写备注 →「加入列表」→ 继续选 →「插入 N 条」一次性写入；
10. 标注钉的备注气泡 **hover 才显示**（不挡页面）；
11. `⌘C` 复制悬停元素的载荷（不插入对话也能贴到别处）。

**标注携带什么**

12. 选择器（`data-testid` > `id` > 自动分配的 `data-ab-id` > `nth-child` 路径）、属性、`role`/`aria-label`；
13. **源码位置** `file:line:col`（React `_debugSource` / Vue `__file` / Svelte `__svelte_meta`）+ **组件栈**；
14. 计算样式子集、位置与视口、父级链、父级文本上下文、outerHTML 截断、页面 route；
15. **元素裁图** PNG（`~/.dsh/data/dsh-annotate-browser/crops/`）；
16. 结构化载荷落 JSON（`~/.dsh/data/dsh-annotate-browser/annotations/<日期>-<host>.json`），输入框里只放一行摘要 + 文件路径。

> 源码位置只在**开发构建**存在；生产站点没有 source map 时退化为「组件名（生产构建无源码映射）」。

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

## 与「长文本胶囊」的接入（dsh-paste-chip）

标注插入对话框时有两层兼容，任何一层生效都会变成芯片：

| 通道 | 做法 | 效果 |
|---|---|---|
| **主动** | `ctx.inject(["pasteChip"])` → `pasteChip.insert(正文, { sessionId, span: inputActions.captureInsertion(), label: "标注 · N 条" })` | 原子插入，标签带条数，草稿里只有芯片 |
| **被动**（兜底） | 退回 `inputActions.setDraft()` 追加文本 | dsh-paste-chip 的差异观察器会认出「外部插入」并折叠成芯片（它 README 里明确列了标注浏览器） |
| **回退**（都不行） | `pasteChip` 不在 / 没有 span / 超 20 万字 → 直接写普通文本 | 内容不丢，只是不折叠 |

胶囊服务缺失时只打印一条 `console.warn`，不影响标注主流程。

## 命令行：启动 / 自检 / 停止

DSH 面板是主入口，但后端可以单独起（不经过 DSH 的 web 鉴权，便于排障）：

```sh
node scripts/annotate-server.mjs          # 自检：连端点、列页面、抓一帧、取一个元素
node scripts/annotate-server.mjs start    # 没端点就拉起一台无头 Chrome 并打开首页
node scripts/annotate-server.mjs stop     # 关闭「本脚本拉起的」Chrome（外部端点不动）
```

输出示例：

```text
端点: ws://127.0.0.1:50272/devtools/browser/…
页面: 3
  - http://127.0.0.1:5173/profile | 清影
截图: 34KB / 38ms
取元素: div | GUEST ACCESS 登录清影账户…
```

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

全部挂在 `/api/annotate-browser/`：

| 路由 | 作用 |
|---|---|
| `GET status` | 连接状态、当前页、推流目标、watcher 数 |
| `GET shot` | 单帧 JPEG（轮询兜底） |
| `GET stream` | SSE 推流（screencast 帧） |
| `POST element` | 坐标 → 元素完整载荷（穿透遮罩、含源码/组件栈/样式/上下文） |
| `POST hover` | 坐标 → DevTools 高亮（`hide:true` 收掉） |
| `POST navigate` / `nav` / `tabs` | 打开网址 / 前进后退刷新 / 标签页 list·new·activate·close |
| `POST viewport` / `mobile` / `freeze` | 视口尺寸 / 移动端模拟 / 冻结动效 |
| `POST input` | 点击·双击·右键·拖拽·滚轮·按键·文本 |
| `POST selection` | 读页面当前选区文字 + 锚点元素 |
| `POST mark` / `marks/clear` | 页面留编号标注 / 清空 |
| `POST annotations` | 结构化载荷落 JSON |
| `GET annotations/count` | 当天同 host 已有条数（编号延续） |
| `POST crop` | 元素裁图 PNG |
| `POST start` / `stop` | 启动 / 关闭**我们自己拉起**的 Chrome |

## 已验证 / 未验证

| 项 | 状态 | 证据 |
|---|---|---|
| CDP 层 / 服务层 / 自启 Chrome | ✅ 已验证 | `test/cdp-smoke.mjs`、`service-smoke.mjs`、`launcher-smoke.mjs` 全部通过 |
| 坐标取元素穿透遮罩 | ✅ 已验证 | DeepSeek 首页同坐标：`div`(1265×813 遮罩) → `A.ds-btn-secondary`(209×44) |
| DevTools 高亮 | ✅ 已验证 | 截图可见白框 + `209.38 × 44` + AX 信息 |
| 截图与面板 1:1 | ✅ 已验证 | 700×880 / 420×760 / 340×640 三种尺寸截图尺寸完全一致 |
| 推流跟随切页 | ✅ 已验证 | SSE 保持连接中途 activate，`streamTarget == page` 同步变化 |
| 移动端模拟 | ✅ 已验证 | `{"w":390,"h":800,"dpr":2,"touch":true}` + iPhone UA |
| 输入转发（含删除/双击） | ✅ 已验证 | Wikipedia 搜索框：`abc` → Backspace → `ab`；双击选中 `[0,5]"hello"` |
| 源码位置 + 组件栈 | ✅ 已验证 | 清影 dev：`pages/Profile/index.tsx:496` + `Profile ← Outlet ← Layout ← Routes ← App` |
| 元素裁图 | ✅ 已验证 | 720×382 PNG 落盘，`sips` 尺寸与元素一致 |
| 面板渲染 | ✅ 已验证（预览台） | `test/preview` 加载真实 `client.js`：`root:true`、无运行时异常 |
| **真实 DSH 内交互全链路** | ❌ 未验收 | 需人手动走：`⌘I` → 悬停白框 → 点选 → 备注 → 加入列表 → 插入 N 条 |

## ROADMAP

- [x] 设置项：wsUrl / chromePath / headless / autoLaunch / profileDir / pollMs / quality / homeUrl / streamMode / streamFps
- [x] 多选：一次标多个，页面打编号，草稿聚合
- [x] 多标签切换 + 导航历史（← → ⟳）
- [x] 元素裁图
- [x] 选中文字标注
- [x] 移动端模拟 / 设备宽度预设
- [ ] 注释胶囊聚合（只占一行，可展开编辑/删除）
- [ ] 模型工具面：`ab_open` / `ab_shot` / `ab_click` / `ab_mark`，让 agent 主动操作
- [ ] 区域框选截图

## 许可

MIT。

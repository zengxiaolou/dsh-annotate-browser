# 从 dsh-browser-cdp 迁移过来的踩坑记录

> 来自旧补丁仓库（已删除）与本地插件 `runtime/PATCHES.md`。
> 这些是 2026-10-23 在 macOS 上实际踩过的坑，写在这里是为了新插件不再重复踩。

## 上游插件的本地改动清单（历史，补丁仓库已删）

## 明确的本地改动（相对 vendored 基线）

| 文件 | 改动 | 原因 / 提交 |
|---|---|---|
| `runtime/ego-linux/src/cursor.mjs` | 光标覆盖层默认名 `Claude` → `DeepSeek`（4 处：默认值 + 注释） | 品牌统一，`dacbd47` |
| `runtime/ego-linux/src/chrome.mjs` | `resolveBinary()`: `candidate.includes("/")` → `isAbsolute(candidate)`；`which()`: Windows 用 `where` 替代 `which` | Windows 支持：POSIX `includes("/")` 不识别 `C:\\` 路径，`which` 在 Windows 不存在 |
| `runtime/ego-linux/src/chrome.mjs` | `LAUNCH_FLAGS` 加 `--no-startup-window`；`launch()` 删除 `"about:blank"` 位置参数 | 消除单次 `ego_space_open` 开两个窗口：原位置参数在默认 browser context 开残留 tab，space tab 走独立 context 又开一个窗口，Chrome 把不同 context 隔离到不同窗口 → 用户看到两窗。`useSpace+ensureRealTab` 路由下不再需要 launch 残留 tab |
| `runtime/ego-linux/src/chrome.mjs` | `launch()` 的 `args` 末尾 spread `filterChromeArgs(process.env.EGO_LINUX_EXTRA_ARGS ?? "")`；新增模块内 `CHROME_BLOCKED` 集合 + `tokenizeArgs`/`filterChromeArgs` 函数（与 `lib/config.js` 镜像，runtime 不 import lib/） | 用户自定义 Chrome 启动参数（设置字段 `chromeArgs`）：插件 `resolveEgoEnv` 把 `chromeArgs` 桥接到 `EGO_LINUX_EXTRA_ARGS`，runtime 切分 + 拉黑控制面标志（`--user-data-dir`/`--remote-debugging-port`/`--headless`/`--proxy-server` 等）后 spread 进 Chrome argv。仅浏览器下次冷启动生效 |
| `runtime/ego-linux/src/chrome.mjs` | `ensureXDisplay()` 增加 `darwin` 伪显示分支（与 win32 分支同构） | **macOS 回归修复（2026-10-23，1.6.0）**：1.6.0 丢了 1.2.3 的 `darwin-desktop` 分支，DISPLAY 未设时落到 `spawnXvfb()` → macOS 没有 Xvfb → `no X display ... no Xvfb binary on PATH`，浏览器完全起不来。升级插件后此补丁需重新应用。备份 `PATCHES.md.bak-20261023` |
| `lib/client.js`（侧栏观察窗 CSS，`TAB_CSS`） | `.dsh-ego-side-body` 改 flex 列、`.dsh-ego-side-liveview` 加 `flex:1 1 auto`、`.dsh-ego-side-liveimg` 去掉 `max-height:50vh` 改 `flex:1 1 auto; min-height:0; max-height:none; object-fit:contain` | **UI 修复（2026-10-23）**：画面被 50vh 钉死，高侧栏下面留一大片空白。改成吃满剩余高度、保持比例不裁切。客户端 bundle，改完需刷新 DSH Web（Cmd+R）才生效；插件升级会被覆盖，需重打 |
| `lib/client.js`（观察窗 UI，第三批） | ① `_egoLocale` 优先跟随宿主语言（localStorage `dsh-ego-locale` → `<html lang>` → `__DSH_BOOT__.locale` → navigator）；② 徽章里的 `streamState` 改走 `streamStateLabel()`（zh: 推流中/启动中/已捕获）；③ `.dsh-ego-side-liveurl` 改单行省略并加 `title` 全文 | **UI 修复（2026-10-23）**：系统英文/DSH 中文时面板整片英文；长 URL 折三行挤占画面。①③ 需刷新 DSH Web 生效；如果仍是英文，控制台执行 `localStorage.setItem('dsh-ego-locale','zh')` 再刷新 |
| `bin/cdp-cast-worker.mjs`（`sendInput`）+ `lib/client.js`（`ResizeObserver`） | worker 的 `sendInput` 新增 `viewport` / `viewportClear` 两种类型（`Emulation.setDeviceMetricsOverride` / `clearDeviceMetricsOverride`）；客户端监听实时画面元素尺寸，防抖 320ms 后把面板实际宽高 + DPR 发给 worker | **面板自适应视口（2026-10-23）**：此前远端按 1280×813 渲染再缩放进面板，面板多宽都是「缩放图」，点击映射依赖缩放换算。改为面板多宽页面就按多宽重排（`object-fit` 不再需要），面板卸载时恢复。worker 改动需重启 cast worker（或重启 dsh）才生效；client 改动需刷新 DSH Web |
| `lib/client.js`（点选投递） | `deliverPickToConversation` 归档成功后追加一行 `〔注释 N〕tag#id「描述」｜备注：`（`pickNoteTemplate`/`appendDraftLine`），两条分支都加（同一页面多次点选 → n 递增） | **点选注释（2026-10-23）**：原来只插一张 picks chip，人没有写注释的落点。现在每次点选草稿里多一行带编号的模板，就地接着打字；多个元素依次编号，与 picks JSON 的 `n` 对应。关掉：`localStorage['dsh-ego-pick-note']='0'`。需刷新 DSH Web |
| `lib/client.js`（点选注释输入条） | `deliverPickWithNote` 包装两处 deliver 调用点；`openPickNoteBar` 在引用成功后弹一个面板内输入条（placeholder、保存/跳过、Enter/Esc）；`applyPickNoteToDraft` 把文字写进草稿最后一条 `〔注释 N〕…｜备注：`（找不到就退化成 `〔备注〕…` 单行） | **点选注释交互（2026-10-23）**：原来点选只有「引用到对话」，没有写注释的入口。现在确认引用后立刻可在面板里写一句注释，多选逐条累加。关掉：`localStorage['dsh-ego-pick-note']='0'`。需刷新 DSH Web |
| `lib/index.js`（`resolveEgoEnv`） | `localHeadless === true` 时补上 `EGO_LINUX_HEADLESS=1`（与 `EGO_ISOLATE_SPACES` 同款写法；只在 true 时强制，避免顶掉 Docker/CI 的自动无头） | **无头配置失效修复（2026-10-23）**：`localHeadless` 之前只传给插件自己的 launcher，工具实际走的 `ego-browser nodejs` 从不读它 → 设置里的「无头运行」形同摆设，每次仍弹窗。需重启 dsh 让插件重载；临时可先 `dsh-browser-stop` 再用 `EGO_LINUX_HEADLESS=1` 预置一个无头实例（插件会复用它） |
| `bin/cdp-cast-worker.mjs`（pick UI/管道）+ `lib/client.js` | 页面内点选卡片新增“注释（选填）”输入框；`report()` 回传 `{action,note}`；`parsePickAction`/`#handleAction` 接收 note 并写进 `state.lastPick.note`；客户端 `deliverPickToConversation` 把 note 落到归档 `entry.note` 与草稿行尾 `｜备注：<note>`；有 note 时不再弹面板输入条 | **选中即注释（2026-10-23）**：之前注释入口在“确认之后”的面板里，用户预期是选中当下就能写。worker 改动需重启 cast worker（或重启 dsh）；client 改动需硬刷新 `Cmd+Shift+R` |
| `bin/cdp-cast-worker.mjs`（pick 卡片）+ `lib/client.js`（预览输入条/视口兜底） | 页面内输入框撤掉（键盘转发不可靠）改为**面板侧**选中即弹输入条，备注按 `backendNodeId` 暂存，等页面「引用到对话」提交时带上；卡片重排版（圆角/毛玻璃/主色按钮）；侧栏每次渲染 1s 节流补一次 `syncPanelViewport`，切标签/重开面板也会收敛 | **选中即注释 v2（2026-10-23）**：①页面输入框收不到键；②卡片丑；③自适应不稳（切标签后才生效）。worker 改动需重启 cast worker；client 改动需 `Cmd+Shift+R` |
| `lib/client.js`（投递通道） | 新增 `pickInputFacadeLatch`（dock 卡片把真实 composer facade 存下来）；`deliverPickToConversation` 头部由「必须 setDraft」放宽为三级回退（宿主服务 → facade.insertText → actions.setDraft）；`appendDraftLine` 与 chip 兜底都改走 `insertText(span)` | **投递失败的根因（2026-10-23）**：真实输入框 facade 只有 `insertText/insertReference`，**没有 `setDraft`**，原代码在头部直接 `no-input-facade` 返回 —— 归档、chip、注释行全都没发生。客户端补丁，需 `Cmd+Shift+R` |
| `bin/cdp-cast-worker.mjs`（/api/input）+ `lib/client.js` | 面板「保存并引用」不再依赖新路由，改为 `POST /api/bcdp/input {type:'pickConfirm',note,targetId}`；worker 在 /api/input 顶部拦截该 type 并调用 `PickChannel.confirm(note)` | **绕过 host 未重启（2026-10-23）**：新加的 `/api/bcdp/pick/confirm` 只在磁盘上，运行中的 dsh 没加载，请求 404、面板按钮“点了没反应”。借道早已存在的 input 路由后，**只需刷新页面**即可。host 版 confirm 路由保留备用（重启后也可用） |
| `bin/cdp-cast-worker.mjs` + `lib/client.js` | ① 页面卡片删除「引用到对话」按钮（确认统一在面板侧）；② 新增 `pickMarks` 通道：worker 按 backendNodeId 取框（失败退回点选时的 rect）并在页面绘制编号徽标（橙底数字 + 虚线框）；客户端记录已标注元素（n + backendNodeId + rect），投递后立即推送、之后每 1.5s 刷新 | **已标注可视化（2026-10-23）**：用户要求“哪个地方标过”一眼可见。徽标绘制已截图验证；**已知限制**：CDP `getBoxModel`/`pushNodesByBackendIdsToFrontend` 在本链路取框失败（返回 0 条），目前用点选时坐标，滚动后会偏移 |
| `bin/cdp-cast-worker.mjs`（编号徽标坐标） | 徽标绘制不再减 `scrollX/scrollY` | **滚动偏移修复（2026-10-23）**：实测 `scrollY=120` 时元素 `getBoundingClientRect().y=686`、`DOM.getBoxModel` 的 content y=691 —— `getBoxModel` 返回的是**视口坐标**，原代码又减了一次 scroll，导致徽标随滚动向上偏。改为直接 fixed 定位后截图验证通过 |
| `runtime/ego-linux/src/paths.mjs` | Windows 用 `%LOCALAPPDATA%\\ego-lite-linux` 作为 DATA_DIR / STATE_DIR；`CHROME_CONFIG_CANDIDATES` 加 Windows 路径 | Windows 支持：XDG 变量在 Windows 不存在；`ego_doctor` 已预期 `%LOCALAPPDATA%` |
| `runtime/ego-linux/bin/ego-browser.mjs` | headless 判定加 `hasDisplay`：有可用 X display（如 Xvfb）时忽略继承的 `EGO_LINUX_HEADLESS=1`，跑 headed | watch 面板全帧率 + ffmpeg x11grab 后端能抓到画面：headless 走 swiftshader ~1fps 且不渲染到 X display（x11grab 抓黑屏）。PR #10 曾回退此逻辑（只认 env），已重新移植（2026-08-18） |
| `runtime/ego-linux/bin/ego-browser.mjs` | 显式 `EGO_LINUX_HEADLESS=1/true/yes/on` 现在优先于 `hasDisplay` 推断（含 win32）；未设置时维持原 hasDisplay 逻辑 | issue #35：此前 win32 硬编码 `hasDisplay=true` 导致显式设置的环境变量被静默忽略，与 CLI help / README 文档矛盾 |
| `runtime/ego-linux/src/task-spaces.mjs` | `createSeededContext()` 增加 `EGO_ISOLATE_SPACES` 环境变量开关支持；未开启（默认）时返回 `null` 复用磁盘 Profile，开启时保留原作者内存沙盒隔离 | 登录态持久化与沙盒隔离双模可配：用户在设置中选择是否开启空间隔离；默认关闭时所有登录态直接落盘，跨关机重启永久保留，开启时恢复独立内存沙盒 |
| `runtime/ego-browser/screenshot-clip.mjs` + `runtime/ego-browser/dist/out/index.js` `screenshot()` | viewport / locator 截图的 CDP clip 原点改为 `pageInfo().sx/sy`（`scrollX/scrollY`），不再固定 `{x:0,y:0}`；fullPage 仍从文档原点截整页 | CDP clip 是文档坐标且默认 `captureBeyondViewport:false`：滚动后 clip 落在未绘制区域会得到空白 PNG。与 `spaces-server.mjs` followClip 同一约定 |
| （其余 runtime 文件）| 与 vendoring 时一致 | 无后续本地改动 |

## 说明

## 新插件里已经规避的

- 无头 Chrome 零标签：`Target.createTarget` 兜底（lib/cdp.js）
- `Runtime.callFunctionOn` 必须是函数声明（lib/cdp.js）
- `DOM.getNodeForLocation` 前要 `DOM.enable`（lib/cdp.js）
- 草稿只能走 `inputActions.setDraft`（lib/client.js）

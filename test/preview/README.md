# 面板预览台

不启动 DSH、不开真浏览器，也能看到 `lib/client.js` 的完整界面。用 mock 后端造假数据，
用真实的 `client.js` + React 18 渲染，再用 CDP 截图。

## 一次性准备

```sh
mkdir -p test/preview/vendor
# React 18 UMD（不入库）
cp ~/.dsh/profiles/desktop/node_modules/react/umd/react.development.js test/preview/vendor/
curl -o test/preview/vendor/react-dom.development.js \
  https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js
```

（`react` 那一步如果本机没有 DSH 插件目录，也可以用同一套 unpkg 地址取。）

## 看图

```sh
node test/preview/server.mjs
# 浏览器打开 http://127.0.0.1:7788/harness.html?state=ready&w=360&h=780
```

`state` 取值：`ready` `picked` `typing` `insert` `blank` `loading` `error` `shoterr` `tall` `tallpicked`
`w`/`h`：侧栏宽度/高度。宽 512 以下走窄栏版式，520 起换宽栏内距，560 起浮卡改为锚定，640 起状态条显示页面标题。

## 批量截图（可选）

```sh
node test/preview/shoot.mjs        # → test/preview/shots/*.png
```

需要 node 22+（脚本用全局 `WebSocket`）和本机 Chrome；换路径用 `CHROME_PATH=...`。
截图脚本会覆盖 `shots/`，两个目录都在 `.gitignore` 里。

## 已知边界

- mock 的时间/文案是固定的，不验证真实 CDP 行为；
- 点击用合成 `MouseEvent`，`?state=picked` 会先点一下「标注」开关再点画面，和真人路径一致；
- 真实宿主（DSH 侧栏、`conversation.input.dock` 槽位）在这里是替身，界面通过不等于宿主接线通过。

/**
 * dsh-annotate-browser —— 客户端：右侧栏「标注浏览器」面板
 * ============================================================================
 * 一次「看画面 → 点元素 → 写一句 → 进对话」的闭环。本文件只负责看与选；
 * 浏览器由 lib/service.js 拉起，草稿由 conversation.input.dock 槽位写入。
 *
 * 设计系统（全部是本文件的私有令牌，前缀 .ab- / --ab-，不泄漏到宿主）
 * ---------------------------------------------------------------------------
 * 深色优先：面板是「工具窗」，长期与截图并置。参照 GitHub Primer 深色，
 *   画布 #0d1117 / letterbox #010409 / 面板 #161b22 / 控件 #21262d
 *   描边 #30363d（弱 #21262d）/ 文字 #e6edf3 · #8b949e · #6e7781
 *   主色 #58a6ff / 主按钮 #238636 / 警告 #d29922 / 失败 #f85149
 *   color-scheme:dark 让原生控件（光标、滚动条、选择色）也跟着走
 *
 * 字号：CJK 在 11px 以下会糊，所以 12px 是正文下限，10–11px 只给「非实质」
 *   信息（计数、尺寸、快捷键、次要元数据）。
 *   10 微标签 < 11 元信息 < 12 正文/输入 < 13 标题
 *
 * 间距：4px 刻度，实际只用 4 / 6 / 8 / 10 / 14 —— 6 是控件内距，
 *   8 是控件之间，10 是面板左右内距（360 宽时两侧各 10，画面还有 340），
 *   14 是 ≥520 宽时的从容内距（宽栏不放宽内距会显得内容被挤在中间）。
 *
 * 高度：44 导航行（28 控件 + 上下 8）/ 34 模式行 / 28 普通控件 / 24 紧凑控件。
 *   28 是「密集面板里仍好点」的下限；24 只给胶囊开关这种二次操作。
 *
 * 圆角：4 微标签 / 6 控件 / 8 浮层 / 10 浮卡 / 999 胶囊。层级越高越圆，
 *   但不超过 10 —— 再大就变成「卡片堆」，不像工具窗。
 *
 * 阴影：只有两处。浮卡 0 16 36（离开画面）/ 缩略图 0 10 30（离开 letterbox）。
 *   其余一律用 1px 描边表达层级，避免深色底上一堆灰雾。
 *
 * 状态矩阵（五种，互斥且都有专属版式）
 *   连接中   spinner + 「正在连接浏览器…」（首次会拉起无头 Chrome，可能 2–5s）
 *   未连接   art + 原因（mono 错误框）+ 重试
 *   空页面   art + 「输入网址开始」+ 三步提示
 *   已连接   画面 + 状态点 + 页地址；错误走底部红条，不打断画面
 *   已选中   画面 + 落点圆钉 + 浮动备注卡（自动聚焦、Enter 插入、Esc 取消）
 *
 * 坐标：截图像素 ≠ 显示像素。frame 按 naturalWidth/Height 等比 contain，
 *   点击用 frame 的 getBoundingClientRect() 换算回截图坐标，误差 ≤1px。
 *   （旧实现用 img 元素宽度换算，letterbox 时会整体偏移——这是本次修的 bug。）
 */

window.__ModuleLoader__.load({
  id: "dsh-annotate-browser",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

    const STYLE_ID = "annotate-browser-style-v2";
    const LEGACY_STYLE_ID = "annotate-browser-style";
    const TAB_ID = "dsh-annotate-browser:panel";

    const ROUTES = {
      status: "/api/annotate-browser/status",
      shot: "/api/annotate-browser/shot",
      stream: "/api/annotate-browser/stream",
      element: "/api/annotate-browser/element",
      hover: "/api/annotate-browser/hover",
      navigate: "/api/annotate-browser/navigate",
      nav: "/api/annotate-browser/nav",
      start: "/api/annotate-browser/start",
      viewport: "/api/annotate-browser/viewport",
      mark: "/api/annotate-browser/mark",
      marksClear: "/api/annotate-browser/marks/clear",
      annotations: "/api/annotate-browser/annotations",
      annotationsCount: "/api/annotate-browser/annotations/count",
      input: "/api/annotate-browser/input"
    };

    /* ------------------------------------------------------------------ *
     * 注释队列：面板（React 树内）→ 草稿（conversation.input.dock 槽位）
     * ------------------------------------------------------------------ */
    const queue = [];
    let flush = null;

    function enqueue(line) {
      if (!line) return;
      queue.push(line);
      if (typeof flush === "function") flush();
    }

    /* ------------------------------------------------------------------ *
     * 纯函数工具
     * ------------------------------------------------------------------ */
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

    const lower = (s) => String(s == null ? "" : s).toLowerCase();

    /** 「button#submit」这种 CSS 选择器写法，比大写 BUTTON 更像代码。 */
    function elementName(el) {
      if (!el) return "element";
      return lower(el.tag) || "element";
    }

    function elementLabel(el) {
      if (!el) return "";
      return elementName(el) + (el.id ? "#" + el.id : "");
    }

    /** 卡片里那行灰字：元素文字优先，其次 class 线索。 */
    function elementSnippet(el) {
      if (!el) return "";
      return String(el.text || el.cls || "").replace(/\s+/g, " ").trim();
    }

    /**
     * 进对话的那一行。格式与旧版保持一致（agent 侧可能按「〔标注〕…｜页面：…」解析），
     * 只做两处收敛：标签小写、备注为空时不再留一个空的「备注：」。
     */
    /**
     * 输入框里只放一行摘要 + JSON 文件路径：
     * 结构化数据（选择器/testid/源码行/样式/上下文）落盘，模型读文件比读长文本准。
     */
    function buildLine(el, note, n, file) {
      if (!el) return "";
      const flat = (v, len) => String(v || "").replace(/\s+/g, " ").trim().slice(0, len);
      const fw = el.framework || {};
      const src = fw.source ? (fw.source.file.split("/").slice(-2).join("/") + ":" + fw.source.line) : "";
      const bits = [
        "〔标注 " + (n || 1) + "〕",
        el.tag + (el.id ? "#" + el.id : ""),
        el.testId ? "[testid=" + el.testId + "]" : "",
        flat(el.text, 28) ? "「" + flat(el.text, 28) + "」" : "",
        src ? "· " + src : "",
        fw.component ? "(" + fw.component + ")" : "",
        note ? "· " + flat(note, 40) : ""
      ].filter(Boolean);
      const tail = file ? "\n　→ 结构：" + file : "";
      return bits.join(" ") + tail;
    }

    /** 地址栏与状态条只显示 host+path，完整 URL 留在 title 里。 */
    function shortUrl(u) {
      const s = String(u || "");
      if (!s) return "";
      try {
        const x = new URL(s);
        const path = x.pathname === "/" ? "" : x.pathname;
        return x.host + path;
      } catch (e) {
        return s.length > 42 ? s.slice(0, 41) + "…" : s;
      }
    }

    /** 统一带超时的 fetch：服务端在等 Chrome 时可能长时间不回，不能吊死 UI。 */
    async function request(url, init, timeoutMs) {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, timeoutMs || 15000) : 0;
      try {
        const opts = Object.assign({ cache: "no-store" }, init || {});
        if (ctl) opts.signal = ctl.signal;
        return await fetch(url, opts);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function readJson(res) {
      try {
        return await res.json();
      } catch (e) {
        return null;
      }
    }

    /** 错误一律转成一句人话，不把 AbortError / TypeError 直接甩到界面上。 */
    function humanError(e, fallback) {
      if (!e) return fallback || "未知错误";
      if (e.name === "AbortError") return "请求超时：后端没有响应";
      const msg = String(e.message || e);
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "连不上 DSH 后端（服务是否在运行？）";
      return msg || fallback || "未知错误";
    }

    /* ------------------------------------------------------------------ *
     * 图标：24×24 feather 风格描边路径，内联 SVG，不依赖字体
     * ------------------------------------------------------------------ */
    const ICONS = {
      back: ["M15 18l-6-6 6-6"],
      forward: ["M9 18l6-6-6-6"],
      reload: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
      arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
      pen: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"],
      close: ["M18 6 6 18", "M6 6l12 12"],
      check: ["M20 6 9 17l-5-5"],
      globe: [
        "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
        "M3 12h18",
        "M12 3a14 14 0 0 1 4 9 14 14 0 0 1-4 9 14 14 0 0 1-4-9 14 14 0 0 1 4-9z"
      ],
      cursor: ["M4 3l6.5 17 2.3-6.7 6.7-2.3z"],
      alert: [
        "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
        "M12 9v4",
        "M12 17h.01"
      ],
      plug: ["M9 2v6", "M15 2v6", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v5"]
    };

    function Icon(props) {
      const paths = ICONS[props.name];
      if (!paths) return null;
      const size = props.size || 13;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: props.width || 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false"
        },
        paths.map((d, i) => h("path", { key: i, d }))
      );
    }

    /* ------------------------------------------------------------------ *
     * 样式：单段 <style>，全部挂在 .ab- 下
     * ------------------------------------------------------------------ */
    const CSS = `
.ab-root{
  --ab-canvas:#0d1117; --ab-letterbox:#010409; --ab-panel:#161b22; --ab-ctl:#21262d; --ab-hover:#30363d;
  --ab-line:#30363d; --ab-line-soft:#21262d;
  --ab-text:#e6edf3; --ab-muted:#8b949e; --ab-subtle:#7d8590; --ab-faint:#6e7781;
  --ab-accent:#58a6ff; --ab-accent-soft:rgba(88,166,255,.14); --ab-accent-line:rgba(88,166,255,.45);
  --ab-ok:#3fb950; --ab-warn:#d29922; --ab-danger:#f85149;
  --ab-primary:#238636; --ab-primary-hi:#2ea043;
  --ab-r-tag:4px; --ab-r-ctl:6px; --ab-r-surface:8px; --ab-r-float:10px;
  --ab-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --ab-sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  position:relative; display:flex; flex-direction:column; box-sizing:border-box;
  width:100%; height:100%; min-width:0; min-height:280px; overflow:hidden;
  background:var(--ab-panel); color:var(--ab-text);
  font-family:var(--ab-sans); font-size:12px; line-height:1.5;
  color-scheme:dark; -webkit-font-smoothing:antialiased; -webkit-tap-highlight-color:transparent;
  container-type:inline-size;
}
.ab-root *{box-sizing:border-box}
.ab-root button{font-family:inherit}
.ab-root :focus-visible{outline:2px solid var(--ab-accent); outline-offset:1px}
.ab-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* ---- 顶部：导航行（44 = 28 控件 + 上下 8） ---- */
.ab-bar{flex:none;display:flex;align-items:center;gap:8px;height:44px;padding:0 10px;
  background:var(--ab-panel);border-bottom:1px solid var(--ab-line-soft)}
.ab-nav{flex:none;display:flex;align-items:center;overflow:hidden;
  background:var(--ab-ctl);border:1px solid var(--ab-line);border-radius:var(--ab-r-ctl)}
.ab-nav button{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;
  background:transparent;color:var(--ab-muted);cursor:pointer;
  transition:background .12s ease,color .12s ease}
.ab-nav button+button{box-shadow:inset 1px 0 0 var(--ab-line-soft)}
.ab-nav button:hover:not(:disabled){background:var(--ab-hover);color:var(--ab-text)}
.ab-nav button:active:not(:disabled){background:#3d444d}
.ab-nav button:disabled{opacity:.38;cursor:default}
.ab-nav button[data-spin="1"] svg{animation:ab-spin .9s linear infinite}

.ab-url{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;
  background:var(--ab-canvas);border:1px solid var(--ab-line);border-radius:var(--ab-r-ctl);
  transition:border-color .12s ease,box-shadow .12s ease}
.ab-url:hover{border-color:#484f58}
.ab-url:focus-within{border-color:#1f6feb;box-shadow:0 0 0 3px rgba(88,166,255,.18)}
.ab-url>svg{flex:none;color:var(--ab-faint)}
.ab-url input{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--ab-text);
  font-family:var(--ab-mono);font-size:11px;line-height:1;outline:none}
.ab-url input::placeholder{color:var(--ab-faint);font-family:var(--ab-sans);font-size:11px}

.ab-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;
  border:1px solid transparent;border-radius:var(--ab-r-ctl);cursor:pointer;white-space:nowrap;
  font-size:11.5px;font-weight:600;line-height:1;
  transition:background .12s ease,border-color .12s ease,color .12s ease}
.ab-btn:disabled{opacity:.45;cursor:default}
.ab-btn--primary{background:var(--ab-primary);border-color:rgba(240,246,252,.1);color:#fff}
.ab-btn--primary:hover:not(:disabled){background:var(--ab-primary-hi)}
.ab-btn--ghost{background:var(--ab-ctl);border-color:var(--ab-line);color:var(--ab-text);font-weight:500}
.ab-btn--ghost:hover:not(:disabled){background:var(--ab-hover);border-color:#484f58}
.ab-btn--quiet{background:transparent;border-color:transparent;color:var(--ab-muted);font-weight:500}
.ab-btn--quiet:hover:not(:disabled){background:var(--ab-ctl);color:var(--ab-text)}
.ab-btn--icon{width:28px;padding:0}
.ab-btn--sm{height:24px;padding:0 8px;font-size:11px;border-radius:5px}

/* ---- 模式行（34）：标注开关 + 状态，兼作状态条，省掉一条页脚 ---- */
.ab-modes{flex:none;display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;
  background:var(--ab-panel);border-bottom:1px solid var(--ab-line)}
.ab-toggle{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px 0 7px;
  border:1px solid var(--ab-line);border-radius:999px;background:var(--ab-ctl);color:var(--ab-muted);
  font-size:11.5px;font-weight:600;cursor:pointer;
  transition:background .14s ease,border-color .14s ease,color .14s ease}
.ab-toggle:hover:not(:disabled){color:var(--ab-text);border-color:#484f58}
.ab-toggle:disabled{opacity:.4;cursor:default}
.ab-toggle[aria-pressed="true"]{background:var(--ab-accent-soft);border-color:var(--ab-accent-line);color:var(--ab-accent)}
.ab-toggle[aria-pressed="true"]:hover{background:rgba(88,166,255,.22)}

.ab-status{display:flex;align-items:center;gap:6px;min-width:0;margin-left:auto;color:var(--ab-subtle);font-size:11px}
.ab-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--ab-faint)}
.ab-dot[data-tone="ok"]{background:var(--ab-ok);box-shadow:0 0 0 3px rgba(63,185,80,.13)}
.ab-dot[data-tone="warn"]{background:var(--ab-warn)}
.ab-dot[data-tone="bad"]{background:var(--ab-danger)}
.ab-status-url{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ab-mono);font-size:10px;color:var(--ab-subtle)}
.ab-status-title{display:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--ab-faint);font-size:10.5px}
.ab-status-sep{display:none;flex:none;color:var(--ab-line);font-size:10px}
.ab-count{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:999px;
  background:var(--ab-ctl);color:var(--ab-muted);
  font-size:10px;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.ab-toast{display:inline-flex;align-items:center;gap:5px;min-width:0;color:var(--ab-ok);font-size:11px;
  font-weight:600;animation:ab-toast-in .22s ease-out both}
.ab-toast span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---- 画面区：letterbox 里放等比缩放后的截图 ---- */
.ab-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  background:var(--ab-letterbox);
  background-image:radial-gradient(120% 76% at 50% -6%,rgba(88,166,255,.07) 0%,rgba(88,166,255,0) 62%);
  overflow:hidden}
.ab-stage[data-armed="1"]{box-shadow:inset 0 0 0 1px rgba(88,166,255,.34)}
.ab-frame{position:relative;flex:none;overflow:hidden;border-radius:2px;background:var(--ab-canvas);
  box-shadow:0 0 0 1px rgba(240,246,252,.07),0 10px 30px rgba(1,4,9,.5)}
.ab-frame img{display:block;width:100%;height:100%;object-fit:fill;
  -webkit-user-drag:none;user-select:none}
.ab-frame[data-armed="1"]{cursor:crosshair}

/* 落点圆钉：18px 环 + 实心点，点一次就有「咬住」的手感 */
.ab-pin{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;
  border:2px solid var(--ab-accent);background:rgba(88,166,255,.16);pointer-events:none;
  box-shadow:0 0 0 3px rgba(88,166,255,.14),0 4px 10px rgba(1,4,9,.55)}
.ab-pin::after{content:"";position:absolute;inset:4px;border-radius:50%;background:var(--ab-accent)}
.ab-pin[data-pending="1"]{border-style:dashed;border-color:rgba(88,166,255,.75);background:transparent;
  animation:ab-pin-wait 1s ease-in-out infinite}
.ab-pin[data-pending="1"]::after{display:none}

/* 顶部提示胶囊：只在标注模式出现，明确「现在点画面有用」 */
.ab-hint{position:absolute;left:10px;top:10px;z-index:3;display:flex;align-items:center;gap:6px;
  height:24px;max-width:calc(100% - 20px);padding:0 9px;border-radius:999px;
  background:rgba(1,4,9,.78);border:1px solid var(--ab-accent-line);color:var(--ab-accent);
  font-size:10.5px;font-weight:600;pointer-events:none;
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);animation:ab-fade-in .16s ease-out both}
.ab-hint span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ab-kbd{flex:none;display:inline-flex;align-items:center;height:15px;padding:0 4px;border-radius:3px;
  border:1px solid rgba(139,148,158,.3);background:rgba(139,148,158,.1);
  font-family:var(--ab-mono);font-size:9.5px;font-weight:500;color:var(--ab-muted)}
.ab-hint .ab-kbd{border-color:rgba(88,166,255,.35);background:rgba(88,166,255,.1);color:#a5d6ff}

/* 导航/加载进度：2px 不确定进度条，压在画面顶部，不遮内容 */
.ab-progress{position:absolute;left:0;right:0;top:0;height:2px;z-index:3;overflow:hidden;
  background:rgba(88,166,255,.1)}
.ab-progress i{position:absolute;top:0;bottom:0;width:38%;border-radius:2px;background:var(--ab-accent);
  animation:ab-indet 1.15s ease-in-out infinite}

/* 居中态：连接中 / 未连接 / 空页面 共用一套骨架，只换 art 与文案 */
.ab-center{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;padding:16px}
.ab-empty{display:flex;flex-direction:column;align-items:center;gap:9px;max-width:292px;text-align:center}
.ab-empty-art{display:grid;place-items:center;width:52px;height:52px;border-radius:12px;
  border:1px dashed var(--ab-line);background:var(--ab-canvas);color:var(--ab-muted)}
.ab-empty-art[data-tone="bad"]{border-color:rgba(248,81,73,.45);background:rgba(248,81,73,.07);color:var(--ab-danger)}
.ab-empty-title{font-size:13px;font-weight:600;letter-spacing:.01em;color:var(--ab-text)}
.ab-empty-body{margin:0;color:var(--ab-muted);font-size:11.5px;line-height:1.65;text-wrap:pretty}
.ab-empty-err{max-width:100%;max-height:76px;overflow:auto;padding:6px 8px;border-radius:6px;
  border:1px solid rgba(248,81,73,.35);background:rgba(248,81,73,.08);color:#ffa198;
  font-family:var(--ab-mono);font-size:10.5px;line-height:1.5;text-align:left;word-break:break-word}
.ab-empty-tip{margin-top:1px;color:var(--ab-faint);font-size:10.5px;line-height:1.65;text-wrap:pretty}
.ab-empty .ab-btn{margin-top:3px}

/* 有画面时的错误：底部红条，不把画面挤走 */
.ab-banner{position:absolute;left:10px;right:10px;bottom:10px;z-index:5;display:flex;align-items:flex-start;gap:7px;
  padding:8px 9px;border-radius:var(--ab-r-surface);border:1px solid rgba(248,81,73,.4);
  background:rgba(45,18,21,.96);color:#ffa198;font-size:11px;line-height:1.5;
  box-shadow:0 10px 24px rgba(1,4,9,.5);animation:ab-toast-in .18s ease-out both}
.ab-banner-text{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ab-banner-acts{flex:none;display:flex;align-items:center;gap:2px}
.ab-banner .ab-btn--sm{color:#ffdcd7}
.ab-banner .ab-btn--sm:hover{background:rgba(255,255,255,.09)}

/* ---- 浮动备注卡：窄/小画面贴底，宽画面贴着落点 ---- */
.ab-card{position:absolute;z-index:4;display:flex;flex-direction:column;gap:8px;padding:10px;
  border-radius:var(--ab-r-float);border:1px solid var(--ab-line);
  background:rgba(22,27,34,.985);box-shadow:0 16px 36px rgba(1,4,9,.66);
  -webkit-backdrop-filter:blur(10px) saturate(1.1);backdrop-filter:blur(10px) saturate(1.1)}
.ab-card--dock{left:10px;right:10px;bottom:10px}
.ab-card--dock-top{left:10px;right:10px;top:10px}
.ab-card--anchor{width:340px;max-width:calc(100% - 20px)}
.ab-card-head{display:flex;align-items:center;gap:6px;min-width:0}
.ab-tag{flex:none;display:inline-flex;align-items:center;max-width:58%;height:18px;padding:0 6px;
  border-radius:var(--ab-r-tag);border:1px solid var(--ab-accent-line);background:var(--ab-accent-soft);
  color:var(--ab-accent);font-family:var(--ab-mono);font-size:10.5px;font-weight:600;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ab-snippet{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--ab-muted);font-size:11px}
.ab-dims{display:none;flex:none;color:var(--ab-faint);font-family:var(--ab-mono);font-size:10px;font-variant-numeric:tabular-nums}
.ab-x{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;
  background:transparent;color:var(--ab-faint);cursor:pointer}
.ab-x:hover{background:var(--ab-ctl);color:var(--ab-text)}
.ab-note{width:100%;height:30px;padding:0 9px;border:1px solid var(--ab-line);border-radius:var(--ab-r-ctl);
  background:var(--ab-canvas);color:var(--ab-text);font-family:inherit;font-size:12px;outline:none;
  transition:border-color .12s ease,box-shadow .12s ease}
.ab-note::placeholder{color:var(--ab-faint)}
.ab-note:focus{border-color:#1f6feb;box-shadow:0 0 0 3px rgba(88,166,255,.2)}
.ab-will{display:flex;align-items:baseline;gap:5px;min-width:0;line-height:1.3;color:var(--ab-faint);font-size:10px}
.ab-will b{flex:none;font-weight:500;letter-spacing:.02em}
.ab-will span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ab-mono);font-size:10px;color:var(--ab-subtle)}
.ab-acts{display:flex;align-items:center;gap:6px}
.ab-acts-hint{margin-right:auto;color:var(--ab-faint);font-size:10px;white-space:nowrap}

@container (min-width:640px){
  .ab-status-title{display:block;max-width:42%}
  .ab-status-sep{display:block}
}

/* ---- 动效 ---- */
@keyframes ab-spin{to{transform:rotate(360deg)}}
@keyframes ab-blink{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes ab-pin-wait{0%,100%{box-shadow:0 0 0 3px rgba(88,166,255,.1)}50%{box-shadow:0 0 0 7px rgba(88,166,255,.05)}}
@keyframes ab-indet{0%{left:-38%}100%{left:100%}}
@keyframes ab-toast-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
@keyframes ab-fade-in{from{opacity:0}to{opacity:1}}
.ab-spin{flex:none;display:inline-block;width:18px;height:18px;border-radius:50%;
  border:2px solid rgba(88,166,255,.22);border-top-color:var(--ab-accent);animation:ab-spin .8s linear infinite}
.ab-spin--sm{width:11px;height:11px;border-width:1.5px}

/* ---- ≥520px：宽侧栏。内容放宽内距，状态条补页面标题，卡片显示元素尺寸 ---- */
@container (min-width:520px){
  .ab-bar{padding:0 14px}
  .ab-modes{padding:0 14px}
  .ab-dims{display:block}
  .ab-card--anchor{width:368px}
  .ab-empty{max-width:340px}
  .ab-empty-body{font-size:12px}
  .ab-empty-title{font-size:13.5px}
}
@media (prefers-reduced-motion:reduce){
  .ab-root *{animation:none!important;transition:none!important}
}
`;

    /** 从 JPEG 字节里读宽高：只扫 SOF 段，避免为了尺寸去整图 decode。 */
    function jpegSize(bytes) {
      try {
        let i = 2;
        while (i < bytes.length - 9) {
          if (bytes[i] !== 0xFF) { i += 1; continue; }
          const m = bytes[i + 1];
          if (m === 0xC0 || m === 0xC1 || m === 0xC2 || m === 0xC3) {
            const h = (bytes[i + 5] << 8) | bytes[i + 6];
            const w = (bytes[i + 7] << 8) | bytes[i + 8];
            if (w > 0 && h > 0) return { w, h };
            break;
          }
          if (m === 0xD8 || m === 0xD9) { i += 2; continue; }
          const len = (bytes[i + 2] << 8) | bytes[i + 3];
          i += 2 + len;
        }
      } catch {}
      return null;
    }

    function ensureStyle() {
      // 旧版本注入的样式没有 id 版本号，留着会和新规则打架（同名类）
      const legacy = document.getElementById(LEGACY_STYLE_ID);
      if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);
      const style = document.getElementById(STYLE_ID);
      if (style) {
        if (style.textContent !== CSS) style.textContent = CSS;
        return;
      }
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /* ------------------------------------------------------------------ *
     * 面板
     * ------------------------------------------------------------------ */
    function PanelTab(props) {
      const visible = !props || props.visible !== false;
      ensureStyle();

      const [status, setStatus] = useState(null); // 原始 /status 响应
      const [frame, setFrame] = useState(null); // {url,w,h} 截图（blob URL）
      const [stage, setStage] = useState({ w: 0, h: 0 });
      const [url, setUrl] = useState("");
      const [armed, setArmed] = useState(false); // 标注模式
      const [pick, setPick] = useState(null); // 已选元素
      const [pin, setPin] = useState(null); // {fx,fy} 落点（画布比例）
      const [pending, setPending] = useState(null); // 取元素中的落点
      const [note, setNote] = useState("");
      const [err, setErr] = useState(""); // 画面层错误（红条）
      const [bootErr, setBootErr] = useState(""); // 连接层错误（居中态）
      const [shotErr, setShotErr] = useState("");
      const [busy, setBusy] = useState("");
      const [count, setCount] = useState(0);
      const [toast, setToast] = useState(null);
      const [pollMs, setPollMs] = useState(1200);
      const [cardPos, setCardPos] = useState(null);

      const rootRef = useRef(null);
      const stageRef = useRef(null);
      const cardRef = useRef(null);
      const toggleRef = useRef(null);
      const urlTouched = useRef(false);
      const frameRef = useRef(null);
      const frameUrlRef = useRef("");
      const inflight = useRef(false);
      const aliveRef = useRef(true);

      const page = (status && status.page) || null;
      // browserUp：浏览器进程连上了（page 可能还是 about:blank）
      const browserUp = !!(status && status.ok === true);
      // connected：真的有页面可看（才允许截图/标注）
      const connected = !!(page && page.url && page.url !== "about:blank");
      const booting = !status && !bootErr;

      /* ---------- 尺寸：宿主容器可能不给高度，逐级向上找一个真有尺寸的祖先 ---------- */
      useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        let applied = 0;
        let lastW = 0;
        let lastH = 0;
        let raf = 0;
        const targets = [];
        let node = el.parentElement;
        for (let i = 0; node && i < 4; i += 1) {
          targets.push(node);
          node = node.parentElement;
        }
        const sync = () => {
          let w = 0;
          let h = 0;
          for (let i = 0; i < targets.length; i += 1) {
            const r = targets[i].getBoundingClientRect();
            if (r.width > 24 && r.height > 24) {
              w = r.width;
              h = r.height;
              break;
            }
          }
          if (!w || !h) return;
          const W = Math.round(w);
          const H = Math.round(h);
          if (W === lastW && H === lastH) return;
          if (applied > 60) return; // 父级随子级变化的病态布局：别再互相推高
          applied += 1;
          lastW = W;
          lastH = H;
          el.style.width = W + "px";
          el.style.height = H + "px";
        };
        const schedule = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            sync();
          });
        };
        sync();
        const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
        if (ro) targets.forEach((t) => ro.observe(t));
        window.addEventListener("resize", schedule);
        const late = setTimeout(schedule, 140); // 宿主完成挂载后再补一次
        return () => {
          if (ro) ro.disconnect();
          window.removeEventListener("resize", schedule);
          clearTimeout(late);
          if (raf) cancelAnimationFrame(raf);
        };
      }, [visible]);

      /* ---------- 画面区尺寸（决定 frame 的等比缩放） ---------- */
      useEffect(() => {
        const el = stageRef.current;
        if (!el) return;
        const sync = () => {
          const w = el.clientWidth;
          const h = el.clientHeight;
          setStage((s) => (s.w === w && s.h === h ? s : { w, h }));
        };
        sync();
        const ro = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
        if (ro) ro.observe(el);
        window.addEventListener("resize", sync);
        return () => {
          if (ro) ro.disconnect();
          window.removeEventListener("resize", sync);
        };
      }, []);

      /* 面板尺寸 → 远端页面视口：不做这一步，1280 宽的桌面页在窄侧栏里会缩成一条，上下全是黑边 */
      useEffect(() => {
        if (!connected) return undefined;
        const w = stage.w;
        const h = stage.h;
        if (!(w >= 240 && h >= 240)) return undefined;
        const timer = setTimeout(() => {
          fetch(ROUTES.viewport, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ width: w, height: h, dpr: window.devicePixelRatio || 1 })
          }).catch(() => {});
        }, 350);
        return () => clearTimeout(timer);
      }, [stage.w, stage.h, connected]);

      useEffect(() => {
        frameRef.current = frame;
      }, [frame]);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
          frameUrlRef.current = "";
        };
      }, []);

      /* ---------- 状态轮询：只在 tab 可见时跑；隐藏 tab 不该继续敲后端 ---------- */
      const applyStatus = useCallback((d) => {
        if (!d || typeof d !== "object") return;
        setStatus(d);
        setBootErr(d.ok === false ? String(d.lastError || "浏览器没有连上") : "");
        const next = Number(d.config && d.config.pollMs);
        if (Number.isFinite(next)) setPollMs(clamp(Math.round(next), 400, 5000));
        const p = d.page;
        if (!urlTouched.current && p && p.url && p.url !== "about:blank") setUrl(p.url);
      }, []);

      const refreshStatus = useCallback(async (timeout) => {
        try {
          const res = await request(ROUTES.status, null, timeout || 15000);
          const d = await readJson(res);
          if (aliveRef.current) applyStatus(d);
          return d;
        } catch (e) {
          if (aliveRef.current) setBootErr((prev) => prev || humanError(e, "状态查询失败"));
          return null;
        }
      }, [applyStatus]);

      useEffect(() => {
        if (!visible) return undefined;
        let alive = true;
        let timer = 0;
        const tick = async () => {
          if (!alive) return;
          if (!document.hidden) await refreshStatus();
          if (alive) timer = setTimeout(tick, 3000);
        };
        tick();
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [visible, refreshStatus]);

      /* ---------- 画面：后台预取成 blob，加载完成才换 src（不闪白、不错帧） ---------- */
      const loadFrame = useCallback(async () => {
        if (inflight.current) return;
        inflight.current = true;
        try {
          const res = await request(ROUTES.shot + "?t=" + Date.now(), null, 12000);
          if (!res.ok) {
            const body = await readJson(res);
            throw new Error((body && (body.error || body.lastError)) || "画面获取失败（HTTP " + res.status + "）");
          }
          const type = res.headers.get("content-type") || "";
          if (type.indexOf("image/") !== 0) throw new Error("画面接口返回的不是图片");
          const blob = await res.blob();
          if (!aliveRef.current) return;
          const objUrl = URL.createObjectURL(blob);
          const probe = new Image();
          probe.onload = () => {
            if (!aliveRef.current) {
              URL.revokeObjectURL(objUrl);
              return;
            }
            const prev = frameUrlRef.current;
            frameUrlRef.current = objUrl;
            setFrame({ url: objUrl, w: probe.naturalWidth || 1, h: probe.naturalHeight || 1 });
            setShotErr("");
            if (prev) setTimeout(() => URL.revokeObjectURL(prev), 2000);
          };
          probe.onerror = () => {
            URL.revokeObjectURL(objUrl);
            if (aliveRef.current) setShotErr("画面解码失败");
          };
          probe.src = objUrl;
        } catch (e) {
          if (aliveRef.current) setShotErr(humanError(e, "画面获取失败"));
        } finally {
          inflight.current = false;
        }
      }, []);

      /* 推流优先：SSE 收到帧就不再用 450ms 轮询（那玩意儿每帧 53ms 截图，卡） */
      const [streaming, setStreaming] = useState(false);
      useEffect(() => {
        if (!visible || !connected) { setStreaming(false); return undefined; }
        if (typeof EventSource !== "function") return undefined;
        let src = null;
        let alive = true;
        try {
          src = new EventSource(ROUTES.stream);
        } catch {
          return undefined;
        }
        src.onopen = () => { if (alive) setStreaming(true); };
        src.onerror = () => { if (alive) setStreaming(false); };
        src.onmessage = (ev) => {
          if (!alive || !ev || !ev.data || ev.data.length < 200) return;
          try {
            const bin = atob(ev.data);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([arr], { type: "image/jpeg" }));
            const prev = frameUrlRef.current;
            frameUrlRef.current = url;
            const dim = jpegSize(arr) || frameRef.current || { w: 0, h: 0 };
            setFrame({ url, w: dim.w, h: dim.h });
            if (prev) setTimeout(() => URL.revokeObjectURL(prev), 1500);
          } catch {}
        };
        return () => { alive = false; try { src.close(); } catch {} };
      }, [visible, connected]);

      useEffect(() => {
        if (!visible || !connected || streaming) return undefined;
        let alive = true;
        let timer = 0;
        const tick = async () => {
          if (!alive) return;
          if (!document.hidden) await loadFrame();
          // 标注模式下调快到 450ms：否则悬停白框要等一整轮轮询才看得到
          if (alive) timer = setTimeout(tick, armed ? Math.min(pollMs, 450) : pollMs);
        };
        tick();
        const onVis = () => {
          if (!document.hidden && alive) loadFrame();
        };
        document.addEventListener("visibilitychange", onVis);
        return () => {
          alive = false;
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", onVis);
        };
      }, [visible, connected, pollMs, loadFrame, armed, streaming]);

      /* ---------- 动作 ---------- */
      const start = useCallback(async () => {
        setBusy("start");
        setBootErr("");
        try {
          const res = await request(ROUTES.start, { method: "POST" }, 25000);
          const d = await readJson(res);
          if (d && d.ok) {
            applyStatus(d);
          } else {
            setBootErr(
              (d && (d.lastError || d.error)) || "启动失败（HTTP " + res.status + "）"
            );
          }
        } catch (e) {
          setBootErr(humanError(e, "启动失败"));
        } finally {
          setBusy("");
          refreshStatus();
        }
      }, [applyStatus, refreshStatus]);

      const go = useCallback(async () => {
        const target = url.trim();
        if (!/^https?:\/\//i.test(target)) {
          setErr("地址需要 http:// 或 https:// 开头");
          return;
        }
        setBusy("go");
        setErr("");
        try {
          const res = await request(
            ROUTES.navigate,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url: target })
            },
            25000
          );
          const d = await readJson(res);
          if (res.ok && d && d.ok) {
            urlTouched.current = false;
            await refreshStatus(8000);
            await loadFrame();
          } else {
            setErr((d && (d.error || d.lastError)) || "打开失败（HTTP " + res.status + "）");
          }
        } catch (e) {
          setErr(humanError(e, "打开失败"));
        } finally {
          setBusy("");
        }
      }, [url, refreshStatus, loadFrame]);

      const nav = useCallback(
        async (action) => {
          setBusy("nav:" + action);
          setErr("");
          try {
            const res = await request(
              ROUTES.nav,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action })
              },
              25000
            );
            const d = await readJson(res);
            if (!res.ok || !d || d.ok === false) {
              setErr((d && (d.error || d.lastError)) || "导航失败（HTTP " + res.status + "）");
            }
            urlTouched.current = false;
            await refreshStatus(8000);
            await loadFrame();
          } catch (e) {
            setErr(humanError(e, "导航失败"));
          } finally {
            setBusy("");
          }
        },
        [refreshStatus, loadFrame]
      );

      const closePick = useCallback(() => {
        setPick(null);
        setPin(null);
        setPending(null);
        setNote("");
        setCardPos(null);
      }, []);

      /* DevTools 式悬停高亮：Overlay 域在页面里画白框，随下一帧截图回来 */
      const lastHoverAt = useRef(0);
      const lastHoverRefresh = useRef(0);
      const pushHover = useCallback(async (x, y) => {
        try {
          await request(ROUTES.hover, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ x: Math.round(x), y: Math.round(y) })
          }, 6000);
          const now = Date.now();
          if (now - lastHoverRefresh.current > 150) {
            lastHoverRefresh.current = now;
            loadFrame();
          }
        } catch {}
      }, [loadFrame]);

      const onFrameMove = useCallback((ev) => {
        if (!armed || !frameRef.current) return;
        const now = Date.now();
        if (now - lastHoverAt.current < 110) return;
        lastHoverAt.current = now;
        const rect = ev.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const fx = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const fy = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
        pushHover(fx * frameRef.current.w, fy * frameRef.current.h);
      }, [armed, pushHover]);

      const onFrameLeave = useCallback(() => {
        if (!armed) return;
        request(ROUTES.hover, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hide: true })
        }, 4000).catch(() => {});
      }, [armed]);

      /* 编号延续：刷新/重开面板后从服务端已有条数接着编号 */
      useEffect(() => {
        if (!connected) return undefined;
        let alive = true;
        fetch(ROUTES.annotationsCount, { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => { if (alive && d && d.ok && Number.isFinite(d.count)) setCount(d.count); })
          .catch(() => {});
        return () => { alive = false; };
      }, [connected]);

      /* 直接操作：非标注模式下，点击/滚轮/键盘转发进页面 */
      const postInput = useCallback((body) => {
        request(
          ROUTES.input,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
          6000
        ).catch(() => {});
      }, []);

      const toPage = useCallback((ev) => {
        const f = frameRef.current;
        if (!f) return null;
        const rect = ev.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const fx = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const fy = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
        return { x: Math.round(fx * f.w), y: Math.round(fy * f.h) };
      }, []);

      const onFrameClickDirect = useCallback((ev) => {
        if (armed) { onFrameClick(ev); return; }
        const pt = toPage(ev);
        if (pt) postInput({ kind: "click", x: pt.x, y: pt.y });
      }, [armed, onFrameClick, toPage, postInput]);

      const onFrameWheel = useCallback((ev) => {
        if (armed) return;
        const pt = toPage(ev);
        if (!pt) return;
        ev.preventDefault();
        postInput({ kind: "wheel", x: pt.x, y: pt.y, deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0 });
      }, [armed, toPage, postInput]);

      const onFrameKeyDown = useCallback((ev) => {
        if (armed) return;
        if (ev.metaKey || ev.ctrlKey) return;
        if (ev.key === "Enter" || ev.key === "Backspace" || ev.key === "Tab" || String(ev.key).indexOf("Arrow") === 0) {
          ev.preventDefault();
          postInput({ kind: "key", key: ev.key, code: ev.code || "" });
          return;
        }
        if (ev.key.length === 1) {
          ev.preventDefault();
          postInput({ kind: "text", text: ev.key });
        }
      }, [armed, postInput]);

      const toggleArmed = useCallback(() => {
        if (armed) {
          closePick(); // 关模式顺手收掉卡片，别留一个半开状态
          request(ROUTES.hover, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hide: true })
          }, 4000).catch(() => {});
        }
        setArmed(!armed);
      }, [armed, closePick]);

      const onFrameClick = useCallback(
        async (ev) => {
          if (!armed || !frameRef.current) return;
          const f = frameRef.current;
          const rect = ev.currentTarget.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const fx = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
          const fy = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
          setPending({ fx, fy });
          setErr("");
          try {
            const res = await request(
              ROUTES.element,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ x: Math.round(fx * f.w), y: Math.round(fy * f.h) })
              },
              15000
            );
            const d = await readJson(res);
            if (res.ok && d && d.ok && d.element) {
              setPick(d.element);
              setPin({ fx, fy });
            } else {
              setErr((d && (d.error || d.lastError)) || "没有取到元素（点位可能落在空白处）");
            }
          } catch (e) {
            setErr(humanError(e, "取元素失败"));
          } finally {
            setPending(null);
          }
        },
        [armed]
      );

      const insert = useCallback(async () => {
        if (!pick) return;
        const n = count + 1;
        // 结构化载荷落盘（失败也要保证对话里有摘要）
        let file = "";
        try {
          const res = await request(
            ROUTES.annotations,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ element: pick, note: note || "", n })
            },
            8000
          );
          const d = await readJson(res);
          if (d && d.ok && d.file) file = d.file;
        } catch {}
        const line = buildLine(pick, note, n, file);
        if (!line) return;
        // 再在页面上留一条持久标注（编号钉 + 备注，滚动/重排后仍贴住元素）
        const f = frameRef.current;
        if (f && pin) {
          request(
            ROUTES.mark,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                x: Math.round(pin.fx * f.w),
                y: Math.round(pin.fy * f.h),
                n,
                note: note || ""
              })
            },
            8000
          ).catch(() => {});
        }
        enqueue(line);
        setCount((n2) => n2 + 1);
        const label = elementLabel(pick);
        setToast({ key: Date.now(), text: "已插入 " + label });
        closePick();
        if (toggleRef.current && typeof toggleRef.current.focus === "function") toggleRef.current.focus();
      }, [pick, note, closePick, count, pin]);

      useEffect(() => {
        if (!toast) return undefined;
        const t = setTimeout(() => setToast(null), 1800);
        return () => clearTimeout(t);
      }, [toast]);

      const onRootKeyDown = useCallback(
        (ev) => {
          if (ev.key !== "Escape") return;
          if (pick) {
            ev.stopPropagation();
            closePick();
          } else if (armed) {
            setArmed(false);
          }
        },
        [pick, armed, closePick]
      );

      /* ---------- 等比缩放 + 卡片定位 ---------- */
      const frameBox = useMemo(() => {
        if (!frame || !stage.w || !stage.h) return { w: 0, h: 0 };
        const pad = 6;
        const availW = Math.max(1, stage.w - pad * 2);
        const availH = Math.max(1, stage.h - pad * 2);
        // 允许放大到 1.5×：小页面在小侧栏里也能点准，再大就糊了
        const scale = Math.min(availW / frame.w, availH / frame.h, 1.5);
        return { w: Math.max(1, Math.round(frame.w * scale)), h: Math.max(1, Math.round(frame.h * scale)) };
      }, [frame, stage]);

      const origin = {
        x: Math.round((stage.w - frameBox.w) / 2),
        y: Math.round((stage.h - frameBox.h) / 2)
      };

      const anchored = !!(pick && pin && stage.w >= 560 && stage.h >= 340);
      // 窄栏/小画面时卡片贴底；但落点本身就在下半区的话贴底会盖住它，于是改贴顶
      const dockTop = !!(
        pick &&
        pin &&
        !anchored &&
        origin.y + pin.fy * frameBox.h > stage.h * 0.55
      );

      useLayoutEffect(() => {
        if (!anchored) {
          setCardPos((p) => (p ? null : p));
          return;
        }
        const el = cardRef.current;
        if (!el) return;
        const cw = el.offsetWidth;
        const ch = el.offsetHeight;
        if (!cw || !ch) return;
        const ax = origin.x + pin.fx * frameBox.w;
        const ay = origin.y + pin.fy * frameBox.h;
        const gap = 16;
        let left = ax + gap;
        let top = ay + gap;
        if (left + cw > stage.w - 10) left = ax - gap - cw;
        if (top + ch > stage.h - 10) top = ay - gap - ch;
        left = clamp(left, 10, Math.max(10, stage.w - cw - 10));
        top = clamp(top, 10, Math.max(10, stage.h - ch - 10));
        const next = { left: Math.round(left), top: Math.round(top) };
        setCardPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
      }, [anchored, pick, pin, frameBox.w, frameBox.h, stage.w, stage.h, origin.x, origin.y, note]);

      /* ---------- 渲染片段 ---------- */
      const dotTone = (() => {
        if (booting || busy === "start") return "idle";
        if (bootErr || !browserUp) return "bad";
        if (shotErr) return frame ? "warn" : "bad";
        return "ok";
      })();

      const statusText = (() => {
        if (booting) return "连接中…";
        if (bootErr || !browserUp) return "未连接";
        if (!connected) return "已连接 · 未打开页面";
        return shortUrl(page && page.url);
      })();

      const navBtn = (action, label, icon) =>
        h(
          "button",
          {
            type: "button",
            title: label,
            "aria-label": label,
            disabled: !connected || !!busy,
            "data-spin": busy === "nav:" + action ? "1" : "0",
            onClick: () => nav(action)
          },
          h(Icon, { name: icon })
        );

      const bar = h(
        "div",
        { className: "ab-bar" },
        h(
          "div",
          { className: "ab-nav", role: "group", "aria-label": "页面导航" },
          navBtn("back", "后退", "back"),
          navBtn("forward", "前进", "forward"),
          navBtn("reload", "刷新", "reload")
        ),
        h(
          "label",
          { className: "ab-url" },
          h(Icon, { name: "globe", size: 11 }),
          h("input", {
            value: url,
            placeholder: "输入网址，回车打开",
            spellCheck: false,
            autoComplete: "off",
            inputMode: "url",
            "aria-label": "页面地址",
            onChange: (e) => {
              urlTouched.current = true;
              setUrl(e.target.value);
            },
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (browserUp) go();
                else start();
              }
            }
          })
        ),
        browserUp
          ? h(
              "button",
              {
                type: "button",
                className: "ab-btn ab-btn--ghost ab-btn--icon",
                title: "打开地址（Enter）",
                "aria-label": "打开地址",
                disabled: busy === "go" || !url.trim(),
                onClick: go
              },
              busy === "go"
                ? h("span", { className: "ab-spin ab-spin--sm" })
                : h(Icon, { name: "arrowRight" })
            )
          : h(
              "button",
              {
                type: "button",
                className: "ab-btn ab-btn--ghost",
                disabled: booting || busy === "start",
                onClick: start
              },
              busy === "start" ? "启动中…" : "启动"
            )
      );

      const modes = h(
        "div",
        { className: "ab-modes" },
        h(
          "button",
          {
            type: "button",
            ref: toggleRef,
            className: "ab-toggle",
            "aria-pressed": armed ? "true" : "false",
            disabled: !connected,
            title: !connected ? "先打开一个页面" : armed ? "关闭标注（Esc）" : "开启后可点选画面里的元素",
            onClick: toggleArmed
          },
          h(Icon, { name: "pen", size: 12 }),
          h("span", null, armed ? "标注中" : "标注")
        ),
        count > 0
          ? h(
              "button",
              {
                type: "button",
                className: "ab-btn",
                "data-variant": "ghost",
                title: "清除页面上的全部标注钉",
                onClick: async () => {
                  try { await request(ROUTES.marksClear, { method: "POST" }, 6000); } catch {}
                  setCount(0);
                }
              },
              "清标记 " + count
            )
          : null,
        h(
          "div",
          { className: "ab-status" },
          count
            ? h("span", { className: "ab-count", title: "本次已插入 " + count + " 条" }, count + " 条")
            : null,
          toast
            ? h(
                "span",
                { key: toast.key, className: "ab-toast" },
                h(Icon, { name: "check", size: 11 }),
                h("span", null, toast.text)
              )
            : h(
                React.Fragment,
                null,
                h("i", { className: "ab-dot", "data-tone": dotTone }),
                h(
                  "span",
                  {
                    className: "ab-status-url",
                    title: (page && [page.title, page.url].filter(Boolean).join(" · ")) || ""
                  },
                  statusText
                ),
                connected && page && page.title
                  ? h(
                      React.Fragment,
                      null,
                      h("span", { className: "ab-status-sep" }, "·"),
                      h("span", { className: "ab-status-title" }, page.title)
                    )
                  : null
              )
        ),
        h("div", { className: "ab-sr", role: "status", "aria-live": "polite" }, toast ? toast.text : "")
      );

      const emptyArt = (name, tone) =>
        h(
          "div",
          { className: "ab-empty-art", "data-tone": tone || "" },
          name === "spin" ? h("span", { className: "ab-spin" }) : h(Icon, { name, size: 22 })
        );

      const center = (() => {
        if (frame && connected) return null;
        const wrap = (...kids) => h("div", { className: "ab-center" }, h("div", { className: "ab-empty" }, ...kids));

        if (booting) {
          return wrap(
            emptyArt("spin"),
            h("div", { className: "ab-empty-title" }, "正在连接浏览器…"),
            h("p", { className: "ab-empty-body" }, "首次连接会拉起一台无头 Chrome，不弹窗口，约需 2–5 秒。")
          );
        }

        if (bootErr) {
          return wrap(
            emptyArt("alert", "bad"),
            h("div", { className: "ab-empty-title" }, "连接失败"),
            h("div", { className: "ab-empty-err" }, bootErr),
            h(
              "button",
              { type: "button", className: "ab-btn ab-btn--primary", disabled: busy === "start", onClick: start },
              busy === "start" ? "启动中…" : "重试"
            ),
            h("div", { className: "ab-empty-tip" }, "设置里可指定 wsUrl / chromePath，或关掉自动启动")
          );
        }

        if (!browserUp) return null;

        if (!connected) {
          return wrap(
            emptyArt("cursor"),
            h("div", { className: "ab-empty-title" }, "输入网址开始"),
            h(
              "p",
              { className: "ab-empty-body" },
              "在上方地址栏粘贴地址并回车，画面每 " + Math.round(pollMs / 100) / 10 + " 秒刷新一次。"
            )
          );
        }

        // 有页面但第一帧还没到
        if (!frame) {
          if (shotErr) {
            return wrap(
              emptyArt("alert", "bad"),
              h("div", { className: "ab-empty-title" }, "画面获取失败"),
              h("div", { className: "ab-empty-err" }, shotErr),
              h(
                "button",
                { type: "button", className: "ab-btn ab-btn--primary", onClick: () => loadFrame() },
                "重试"
              )
            );
          }
          return wrap(
            emptyArt("spin"),
            h("div", { className: "ab-empty-title" }, "正在获取画面…"),
            h("p", { className: "ab-empty-body" }, "页面已打开，等第一帧截图回来。")
          );
        }

        return null;
      })();

      const card = pick
        ? h(
            "div",
            {
              ref: cardRef,
              className:
                "ab-card " + (anchored ? "ab-card--anchor" : dockTop ? "ab-card--dock-top" : "ab-card--dock"),
              style:
                anchored && cardPos
                  ? { left: cardPos.left + "px", top: cardPos.top + "px" }
                  : anchored
                  ? { left: "0px", top: "0px", visibility: "hidden" }
                  : null,
              role: "dialog",
              "aria-label": "标注备注",
              onClick: (e) => e.stopPropagation()
            },
            h(
              "div",
              { className: "ab-card-head" },
              h("span", { className: "ab-tag", title: elementLabel(pick) }, elementLabel(pick)),
              h("span", { className: "ab-snippet", title: elementSnippet(pick) }, elementSnippet(pick)),
              pick.rect && pick.rect.w
                ? h("span", { className: "ab-dims" }, pick.rect.w + "×" + pick.rect.h)
                : null,
              h(
                "button",
                {
                  type: "button",
                  className: "ab-x",
                  title: "取消（Esc）",
                  "aria-label": "取消标注",
                  onClick: closePick
                },
                h(Icon, { name: "close", size: 12 })
              )
            ),
            h("input", {
              className: "ab-note",
              autoFocus: true,
              value: note,
              placeholder: "这个元素要改成什么？",
              "aria-label": "备注",
              onChange: (e) => setNote(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  insert();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closePick();
                }
              }
            }),
            h(
              "div",
              { className: "ab-will" },
              h("b", null, "将插入"),
              h("span", { title: buildLine(pick, note) }, buildLine(pick, note))
            ),
            h(
              "div",
              { className: "ab-acts" },
              h(
                "span",
                { className: "ab-acts-hint" },
                h("span", { className: "ab-kbd" }, "Enter"),
                " 插入 · ",
                h("span", { className: "ab-kbd" }, "Esc"),
                " 取消"
              ),
              h(
                "button",
                { type: "button", className: "ab-btn ab-btn--ghost ab-btn--sm", onClick: closePick },
                "取消"
              ),
              h(
                "button",
                { type: "button", className: "ab-btn ab-btn--primary ab-btn--sm", onClick: insert },
                "插入对话"
              )
            )
          )
        : null;

      const bannerText = err || (frame ? shotErr || bootErr : "");
      const banner =
        bannerText && !pick
          ? h(
              "div",
              { className: "ab-banner", role: "alert" },
              h(Icon, { name: "alert", size: 13 }),
              h("div", { className: "ab-banner-text", title: bannerText }, bannerText),
              h(
                "div",
                { className: "ab-banner-acts" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "ab-btn ab-btn--sm",
                    onClick: () => {
                      setErr("");
                      loadFrame();
                      refreshStatus(8000);
                    }
                  },
                  "重试"
                ),
                err
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "ab-btn ab-btn--sm",
                        "aria-label": "关闭提示",
                        onClick: () => setErr("")
                      },
                      h(Icon, { name: "close", size: 11 })
                    )
                  : null
              )
            )
          : null;

      const stageNode = h(
        "div",
        { className: "ab-stage", ref: stageRef, "data-armed": armed ? "1" : "0" },
        frame && frameBox.w
          ? h(
              "div",
              {
                className: "ab-frame",
                "data-armed": armed ? "1" : "0",
                style: { width: frameBox.w + "px", height: frameBox.h + "px" },
                tabIndex: armed ? -1 : 0,
                onClick: onFrameClickDirect,
                onMouseMove: onFrameMove,
                onMouseLeave: onFrameLeave,
                onWheel: onFrameWheel,
                onKeyDown: onFrameKeyDown
              },
              h("img", { src: frame.url, alt: page && page.title ? page.title : "页面截图", draggable: false })
            )
          : null,
        pending
          ? h("i", {
              className: "ab-pin",
              "data-pending": "1",
              style: {
                left: origin.x + pending.fx * frameBox.w + "px",
                top: origin.y + pending.fy * frameBox.h + "px"
              }
            })
          : null,
        pick && pin
          ? h("i", {
              className: "ab-pin",
              style: {
                left: origin.x + pin.fx * frameBox.w + "px",
                top: origin.y + pin.fy * frameBox.h + "px"
              }
            })
          : null,
        armed && connected && !pick
          ? h(
              "div",
              { className: "ab-hint" },
              h(Icon, { name: "cursor", size: 11 }),
              h("span", null, "点画面选元素"),
              h("i", { className: "ab-kbd" }, "Esc")
            )
          : null,
        busy === "go" || busy.indexOf("nav:") === 0
          ? h("div", { className: "ab-progress" }, h("i", null))
          : null,
        center,
        card,
        banner
      );

      return h(
        "div",
        { className: "ab-root", ref: rootRef, onKeyDown: onRootKeyDown },
        bar,
        modes,
        stageNode
      );
    }

    /* ------------------------------------------------------------------ *
     * 隐藏的草稿写入器：只有这个槽位能拿到 inputActions.setDraft
     * ------------------------------------------------------------------ */
    function DraftWriter(props) {
      const live = typeof props.useInput === "function" ? props.useInput((s) => s) : null;
      useEffect(() => {
        flush = () => {
          if (!queue.length) return;
          const actions = props.inputActions;
          if (!actions || typeof actions.setDraft !== "function") return;
          const draft = live && typeof live.draft === "string" ? live.draft : "";
          const add = queue.splice(0).join("\n");
          const next = draft ? draft + (/\n$/.test(draft) ? "" : "\n") + add : add;
          try {
            actions.setDraft(next);
          } catch (e) {
            queue.unshift(add); // 写失败就把内容放回队列，下一轮再试，不丢
            if (typeof console !== "undefined" && console.warn) {
              console.warn("[annotate-browser] setDraft 失败，已重新排队：", e);
            }
          }
        };
        const timer = setInterval(() => {
          if (queue.length) flush();
        }, 500);
        return () => {
          clearInterval(timer);
          flush = null;
        };
      }, [live, props.inputActions]);
      return null;
    }

    function apply(ctx) {
      ensureStyle();

      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          { name: "conversation.input.dock", id: "annotate-browser-writer-v1", order: 90 },
          DraftWriter
        )
      );

      const registerTab = (host) => {
        let sidebar = null;
        try {
          sidebar = host.get("betterSidebar");
        } catch (e) {
          sidebar = host.betterSidebar;
        }
        if (!sidebar || typeof sidebar.registerTab !== "function") return;
        host.effect(() =>
          sidebar.registerTab({
            id: TAB_ID,
            title: () => "标注浏览器",
            description: () => "看目标页面实时截图，点元素写备注，插入对话",
            order: 70,
            single: true,
            component: PanelTab
          })
        );
      };
      if (typeof ctx.inject === "function") ctx.inject(["betterSidebar"], registerTab);
      else registerTab(ctx);
    }

    return { inject: ["slots"], apply };
  }
});

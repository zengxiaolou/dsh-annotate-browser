/**
 * dsh-annotate-browser 客户端
 * - 右侧栏 Tab「标注浏览器」：工具条（← → ⟳ / 地址栏 / 标注开关 / 打开）+ 自适应画面 + 浮动注释卡
 * - 面板尺寸跟随侧栏容器（ResizeObserver 强制同步，避免宿主不给高度时塌成半屏）
 * - 草稿写入只能在 conversation.input.dock 槽位拿到 inputActions，所以保留一个不可见写入器
 */
window.__ModuleLoader__.load({
  id: "dsh-annotate-browser",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const STYLE_ID = "annotate-browser-style";
    const TAB_ID = "dsh-annotate-browser:panel";
    const ROUTES = {
      status: "/api/annotate-browser/status",
      shot: "/api/annotate-browser/shot",
      element: "/api/annotate-browser/element",
      navigate: "/api/annotate-browser/navigate",
      nav: "/api/annotate-browser/nav",
      start: "/api/annotate-browser/start"
    };

    /* ---------------- 注释队列：面板 → 草稿 ---------------- */
    const queue = [];
    let flush = null;
    function enqueue(line) {
      if (!line) return;
      queue.push(line);
      if (typeof flush === "function") flush();
    }

    /* ---------------- 图标（内联 SVG，避免字体差异） ---------------- */
    const icon = (path, size = 13) =>
      h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: path })
      );
    const ICONS = {
      back: "M10 3 5 8l5 5",
      forward: "M6 3l5 5-5 5",
      reload: "M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3",
      lock: "M5 7V5a3 3 0 0 1 6 0v2M4 7h8v6H4z",
      pen: "M3 13l1-3 6-6 2 2-6 6-3 1zM10 3l1 1"
    };

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      // 视觉令牌对齐 dsh-pr-panel（GitHub Primer 深色）
      style.textContent = [
        ".ab-root{display:flex;flex-direction:column;min-width:0;min-height:0;background:#0d1117;color:#e6edf3;font:11px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;overflow:hidden}",
        /* 工具条 */
        ".ab-top{flex:none;display:flex;align-items:center;gap:8px;height:44px;padding:0 10px;background:#161b22;border-bottom:1px solid #30363d}",
        ".ab-nav{display:flex;align-items:center;background:#21262d;border:1px solid #30363d;border-radius:6px;overflow:hidden;flex:none}",
        ".ab-nav button{width:28px;height:26px;display:grid;place-items:center;background:transparent;border:none;color:#8b949e;cursor:pointer}",
        ".ab-nav button:hover:not(:disabled){background:#30363d;color:#e6edf3}",
        ".ab-nav button:disabled{opacity:.4;cursor:default}",
        ".ab-nav button+button{border-left:1px solid #30363d}",
        ".ab-addr{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:28px;padding:0 9px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3}",
        ".ab-addr:focus-within{border-color:#1f6feb;box-shadow:0 0 0 3px rgba(31,111,235,.3)}",
        ".ab-addr svg{color:#6e7781;flex:none}",
        ".ab-addr input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:inherit;font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace}",
        ".ab-addr input::placeholder{color:#6e7781}",
        ".ab-btn{cursor:pointer;height:28px;padding:0 11px;border-radius:6px;border:1px solid rgba(240,246,252,.1);background:#238636;color:#fff;font:600 11px/26px inherit;flex:none;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}",
        ".ab-btn:hover{background:#2ea043}",
        ".ab-btn:disabled{opacity:.45;cursor:default}",
        ".ab-btn.ghost{background:#21262d;border-color:#30363d;color:#e6edf3;font-weight:400}",
        ".ab-btn.ghost:hover{background:#30363d;border-color:#8b949e}",
        ".ab-btn.on{background:rgba(88,166,255,.16);border-color:#58a6ff;color:#58a6ff}",
        ".ab-btn.on:hover{background:rgba(88,166,255,.24)}",
        /* 画面 */
        ".ab-stage{position:relative;flex:1;min-height:0;margin:8px 10px 0;border-radius:8px;border:1px solid #30363d;background:#010409;display:flex;overflow:hidden}",
        ".ab-shot{width:100%;height:100%;object-fit:contain;display:block}",
        ".ab-shot.annotating{cursor:crosshair}",
        ".ab-empty{margin:auto;padding:20px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;color:#8b949e;max-width:280px}",
        ".ab-empty b{color:#e6edf3;font-size:12px}",
        ".ab-empty small{font-size:10px;line-height:1.7}",
        /* 浮动注释卡 */
        ".ab-card{position:absolute;left:10px;right:10px;bottom:10px;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:8px;background:rgba(22,27,34,.97);border:1px solid #30363d;box-shadow:0 12px 28px rgba(1,4,9,.7)}",
        ".ab-card-head{display:flex;align-items:center;gap:6px;min-width:0}",
        ".ab-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:rgba(88,166,255,.16);border:1px solid rgba(88,166,255,.4);color:#58a6ff;font-size:10px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}",
        ".ab-badge.warn{background:rgba(210,153,34,.18);border-color:rgba(210,153,34,.5);color:#d29922}",
        ".ab-el{font-size:10px;color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
        ".ab-note{width:100%;box-sizing:border-box;height:30px;padding:0 9px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font:11px/28px inherit;outline:none}",
        ".ab-note::placeholder{color:#6e7781}",
        ".ab-note:focus{border-color:#1f6feb;box-shadow:0 0 0 3px rgba(31,111,235,.3)}",
        ".ab-row{display:flex;gap:6px;justify-content:flex-end}",
        /* 底部提示 */
        ".ab-foot{flex:none;display:flex;align-items:center;gap:6px;height:26px;padding:0 12px;color:#6e7781;font-size:10px}",
        ".ab-foot .dot{width:6px;height:6px;border-radius:999px;background:#3fb950;flex:none}",
        ".ab-foot .dot.bad{background:#f85149}"
      ].join("\n");
      document.head.appendChild(style);
    }

    /* ---------------- 右侧面板 ---------------- */
    function PanelTab() {
      ensureStyle();
      const [tick, setTick] = useState(0);
      const [page, setPage] = useState(null);
      const [url, setUrl] = useState("");
      const [annotating, setAnnotating] = useState(false);
      const [pick, setPick] = useState(null);
      const [note, setNote] = useState("");
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState(false);
      const [count, setCount] = useState(0);
      const rootRef = useRef(null);
      const imgRef = useRef(null);
      const urlTouched = useRef(false);
      const connected = !!(page && page.url && page.url !== "about:blank");

      /* 尺寸跟随侧栏容器：宿主容器不给高度时 100% 会塌，这里强制同步 */
      useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const parent = el.parentElement;
        if (!parent) return;
        const sync = () => {
          const r = parent.getBoundingClientRect();
          if (r.width > 0) el.style.width = Math.round(r.width) + "px";
          if (r.height > 0) el.style.height = Math.round(r.height) + "px";
        };
        sync();
        const ro = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
        if (ro) ro.observe(parent);
        window.addEventListener("resize", sync);
        return () => {
          if (ro) ro.disconnect();
          window.removeEventListener("resize", sync);
        };
      }, []);

      useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), 1200);
        return () => clearInterval(timer);
      }, []);

      useEffect(() => {
        let alive = true;
        fetch(`${ROUTES.status}?t=${tick}`, { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => {
            if (!alive || !d) return;
            setPage(d.page || null);
            if (!urlTouched.current && d.page && d.page.url && d.page.url !== "about:blank") setUrl(d.page.url);
            setErr(d.ok ? "" : d.lastError || "");
          })
          .catch(() => {});
        return () => { alive = false; };
      }, [tick]);

      const start = useCallback(async () => {
        setBusy(true);
        try {
          await fetch(ROUTES.start, { method: "POST" }).then((r) => r.json());
          setTick((n) => n + 1);
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, []);

      const go = useCallback(async () => {
        const target = url.trim();
        if (!/^https?:\/\//i.test(target)) { setErr("请输入 http(s):// 开头的网址"); return; }
        setBusy(true);
        setErr("");
        try {
          const res = await fetch(ROUTES.navigate, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: target })
          }).then((r) => r.json());
          if (res && res.ok) { urlTouched.current = false; setTick((n) => n + 1); }
          else setErr((res && res.error) || "打开失败");
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [url]);

      const nav = useCallback(async (action) => {
        try {
          await fetch(ROUTES.nav, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action })
          }).then((r) => r.json());
          urlTouched.current = false;
          setTick((n) => n + 1);
        } catch (e) {
          setErr(String((e && e.message) || e));
        }
      }, []);

      const onStageClick = useCallback(async (ev) => {
        if (!annotating) return; // 只有标注模式下才取元素
        const img = imgRef.current;
        if (!img) return;
        const rect = img.getBoundingClientRect();
        const sx = (img.naturalWidth || rect.width) / rect.width;
        const sy = (img.naturalHeight || rect.height) / rect.height;
        const x = Math.round((ev.clientX - rect.left) * sx);
        const y = Math.round((ev.clientY - rect.top) * sy);
        try {
          const res = await fetch(ROUTES.element, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ x, y })
          }).then((r) => r.json());
          if (res && res.ok) { setPick(res.element); setErr(""); }
          else setErr((res && res.error) || "取元素失败");
        } catch (e) {
          setErr(String((e && e.message) || e));
        }
      }, [annotating]);

      const insert = useCallback(() => {
        if (!pick) return;
        const head = `〔标注〕${pick.tag || "element"}${pick.id ? "#" + pick.id : ""}`;
        const text = pick.text ? `「${String(pick.text).slice(0, 40)}」` : "";
        const where = `${pick.pageTitle || ""} ${pick.pageUrl || ""}`.trim();
        enqueue(`${head}${text}｜页面：${where}｜备注：${note.trim()}`);
        setPick(null);
        setNote("");
        setCount((n) => n + 1);
      }, [pick, note]);

      return h(
        "div",
        { className: "ab-root", ref: rootRef },
        /* 工具条 */
        h(
          "div",
          { className: "ab-top" },
          h(
            "div",
            { className: "ab-nav" },
            h("button", { type: "button", title: "后退", disabled: !connected, onClick: () => nav("back") }, icon(ICONS.back)),
            h("button", { type: "button", title: "前进", disabled: !connected, onClick: () => nav("forward") }, icon(ICONS.forward)),
            h("button", { type: "button", title: "刷新", disabled: !connected, onClick: () => nav("reload") }, icon(ICONS.reload))
          ),
          h(
            "div",
            { className: "ab-addr" },
            icon(ICONS.lock, 11),
            h("input", {
              value: url,
              placeholder: "输入网址后回车",
              spellCheck: false,
              onChange: (e) => { urlTouched.current = true; setUrl(e.target.value); },
              onKeyDown: (e) => { if (e.key === "Enter") go(); }
            })
          ),
          h(
            "button",
            {
              type: "button",
              className: "ab-btn ghost" + (annotating ? " on" : ""),
              disabled: !connected,
              title: "开启后可在画面上点选元素",
              onClick: () => { setAnnotating((v) => !v); setPick(null); }
            },
            icon(ICONS.pen),
            annotating ? "标注中" : "标注"
          ),
          connected
            ? h("button", { type: "button", className: "ab-btn", disabled: busy, onClick: go }, busy ? "…" : "打开")
            : h("button", { type: "button", className: "ab-btn", disabled: busy, onClick: start }, busy ? "启动中…" : "启动")
        ),
        /* 画面 */
        h(
          "div",
          { className: "ab-stage", onClick: onStageClick },
          connected
            ? h("img", {
                className: "ab-shot" + (annotating ? " annotating" : ""),
                ref: imgRef,
                src: `${ROUTES.shot}?t=${tick}`,
                alt: "page",
                draggable: false
              })
            : h(
                "div",
                { className: "ab-empty" },
                h("b", null, "还没有浏览器"),
                h("small", null, "点右上「启动」会拉起一台无头 Chrome（不弹窗口），然后在地址栏输入网址"),
                h("button", { type: "button", className: "ab-btn", disabled: busy, onClick: (e) => { e.stopPropagation(); start(); } }, busy ? "启动中…" : "启动浏览器")
              ),
          pick
            ? h(
                "div",
                { className: "ab-card", onClick: (e) => e.stopPropagation() },
                h(
                  "div",
                  { className: "ab-card-head" },
                  h("span", { className: "ab-badge" }, `${pick.tag}${pick.id ? "#" + pick.id : ""}`),
                  h("span", { className: "ab-el" }, pick.text || pick.cls || "")
                ),
                h("input", {
                  className: "ab-note",
                  autoFocus: true,
                  placeholder: "这个元素要改成什么？",
                  value: note,
                  onChange: (e) => setNote(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === "Enter") { e.preventDefault(); insert(); }
                    if (e.key === "Escape") { setPick(null); setNote(""); }
                  }
                }),
                h(
                  "div",
                  { className: "ab-row" },
                  h("button", { type: "button", className: "ab-btn ghost", onClick: () => { setPick(null); setNote(""); } }, "取消"),
                  h("button", { type: "button", className: "ab-btn", onClick: insert }, "插入对话")
                )
              )
            : null
        ),
        /* 底部状态 */
        h(
          "div",
          { className: "ab-foot" },
          h("span", { className: "dot" + (connected ? "" : " bad") }),
          connected
            ? (annotating ? "标注中：点画面里的元素" : "点工具条「标注」开启点选")
            : "未连接浏览器",
          count ? ` · 已插入 ${count} 条` : "",
          err ? h("span", { className: "ab-badge warn", style: { marginLeft: "auto" } }, err) : null
        )
      );
    }

    /* ---------------- 隐藏草稿写入器 ---------------- */
    function DraftWriter(props) {
      const live = typeof props.useInput === "function" ? props.useInput((s) => s) : null;
      useEffect(() => {
        flush = () => {
          if (!queue.length) return;
          const actions = props.inputActions;
          if (!actions || typeof actions.setDraft !== "function") return;
          const draft = live && typeof live.draft === "string" ? live.draft : "";
          const add = queue.splice(0).join("\n");
          const next = draft ? draft + (draft.endsWith("\n") ? "" : "\n") + add : add;
          try { actions.setDraft(next); } catch {}
        };
        const timer = setInterval(() => flush && flush(), 600);
        return () => { clearInterval(timer); flush = null; };
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
        try { sidebar = host.get("betterSidebar"); } catch { sidebar = host.betterSidebar; }
        if (!sidebar || typeof sidebar.registerTab !== "function") return;
        host.effect(() =>
          sidebar.registerTab({
            id: TAB_ID,
            title: () => "标注浏览器",
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

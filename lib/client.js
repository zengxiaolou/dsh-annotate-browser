/**
 * dsh-annotate-browser 客户端：
 * - 右侧栏注册「标注浏览器」Tab（走 better-sidebar），面板里是 CDP 实时画面 + 点选 + 备注
 * - 输入框 dock 槽位保留一个**不可见**组件，只负责拿 inputActions 把注释写进草稿
 *   （草稿只能在这个槽位里拿，面板自己拿不到）
 */
window.__ModuleLoader__.load({
  id: "dsh-annotate-browser",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = "annotateBrowser";
    const STYLE_ID = "annotate-browser-style";
    const TAB_ID = "dsh-annotate-browser:panel";
    const ROUTES = {
      shot: "/api/annotate-browser/shot",
      element: "/api/annotate-browser/element",
      navigate: "/api/annotate-browser/navigate",
      status: "/api/annotate-browser/status",
      start: "/api/annotate-browser/start"
    };

    const zh = {
      title: "标注浏览器",
      hint: "点画面里要改的地方，写一句，插入对话",
      picked: "已选中",
      note: "这个元素要改成什么？",
      insert: "插入对话",
      inserted: "已插入 ×",
      cancel: "清除",
      open: "打开网址…",
      failed: "取元素失败",
      loading: "未连接浏览器",
      start: "启动浏览器",
      go: "打开",
      reload: "刷新",
      urlPlaceholder: "输入网址，回车打开（例如 https://example.com）"
    };

    /* ---------- 注释队列：面板产生 → dock 写入草稿 ---------- */
    const queue = [];
    let flush = null;
    function enqueue(line) {
      if (!line) return false;
      queue.push(line);
      if (typeof flush === "function") flush();
      return queue.length === 0;
    }

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
                ".ab-root{display:flex;flex-direction:column;height:100%;min-height:0;background:linear-gradient(180deg,rgba(255,255,255,.03),transparent 40%);color:inherit;font:12px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}",
        ".ab-top{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.18);flex:none}",
        ".ab-dot{width:8px;height:8px;border-radius:50%;background:#30d158;box-shadow:0 0 6px rgba(48,209,88,.6);flex:none}",
        ".ab-dot.bad{background:#ff453a;box-shadow:0 0 6px rgba(255,69,58,.5)}",
        ".ab-url{flex:1;min-width:0;height:30px;padding:0 11px;border-radius:9px;border:1px solid rgba(128,128,128,.28);background:rgba(0,0,0,.22);color:inherit;font:12px/30px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;outline:none}",
        ".ab-url:focus{border-color:#0a84ff;box-shadow:0 0 0 3px rgba(10,132,255,.18)}",
        ".ab-btn{cursor:pointer;border:none;border-radius:9px;background:#0a84ff;color:#fff;font:inherit;font-weight:600;height:30px;padding:0 12px;flex:none;transition:filter .15s}",
        ".ab-btn:hover{filter:brightness(1.08)}",
        ".ab-btn:disabled{opacity:.45;cursor:default;filter:none}",
        ".ab-btn.ghost{background:rgba(128,128,128,.16);border:1px solid rgba(128,128,128,.28);font-weight:400;color:inherit}",
        ".ab-stage{flex:1;min-height:0;margin:10px;border-radius:12px;border:1px solid rgba(128,128,128,.22);background:#0a0a0a;display:flex;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}",
        ".ab-shot{width:100%;height:100%;object-fit:contain;display:block;cursor:crosshair}",
        ".ab-empty{opacity:.62;padding:20px;text-align:center;margin:auto;display:flex;flex-direction:column;gap:10px;align-items:center}",
        ".ab-empty small{opacity:.7;font-size:11px}",
        ".ab-bottom{flex:none;display:flex;flex-direction:column;gap:8px;padding:0 10px 10px}",
        ".ab-picked{font-size:11px;opacity:.68;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".ab-note{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border-radius:9px;border:1px solid rgba(128,128,128,.3);background:rgba(0,0,0,.2);color:inherit;font:inherit;outline:none}",
        ".ab-note:focus{border-color:#0a84ff}",
        ".ab-row{display:flex;gap:8px;justify-content:flex-end}",
        ".ab-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}",
        ".ab-dot{width:7px;height:7px;border-radius:50%;background:#30d158;flex:none}",
        ".ab-dot.bad{background:#ff453a}",
        ".ab-meta{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}",
        ".ab-stage{flex:1;min-height:0;overflow:hidden;border-radius:9px;border:1px solid rgba(128,128,128,.22);background:#0a0a0a;display:flex}",
        ".ab-shot{width:100%;height:100%;object-fit:contain;display:block;cursor:crosshair}",
        ".ab-empty{opacity:.55;padding:16px;text-align:center;margin:auto}",
        ".ab-note{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:9px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.12);color:inherit;font:inherit;outline:none;flex:none}",
        ".ab-btn{cursor:pointer;border:none;border-radius:8px;background:#0a84ff;color:#fff;font:inherit;font-weight:600;padding:5px 12px;flex:none}",
        ".ab-btn:disabled{opacity:.45;cursor:default}",
        ".ab-btn.ghost{background:transparent;border:1px solid rgba(128,128,128,.32);font-weight:400;color:inherit}",
        ".ab-picked{font-size:11px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}"
      ].join("\n");
      document.head.appendChild(style);
    }

    /* ---------------- 右侧面板 ---------------- */
    function PanelTab() {
      ensureStyle();
      const [tick, setTick] = useState(0);
      const [pick, setPick] = useState(null);
      const [note, setNote] = useState("");
      const [err, setErr] = useState("");
      const [page, setPage] = useState(null);
      const [url, setUrl] = useState("");
      const [busy, setBusy] = useState(false);
      const [inserted, setInserted] = useState(0);
      const imgRef = useRef(null);
      const urlTouched = useRef(false);
      const connected = !!(page && page.url && page.url !== "about:blank");

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

      const onPick = useCallback(async (ev) => {
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
          else setErr((res && res.error) || zh.failed);
        } catch (e) {
          setErr(String((e && e.message) || e));
        }
      }, []);

      const insert = useCallback(() => {
        if (!pick) return;
        const head = `〔标注〕${pick.tag || "element"}${pick.id ? "#" + pick.id : ""}`;
        const text = pick.text ? `「${String(pick.text).slice(0, 40)}」` : "";
        const where = `${pick.pageTitle || ""} ${pick.pageUrl || ""}`.trim();
        enqueue(`${head}${text}｜页面：${where}｜备注：${note.trim()}`);
        setPick(null);
        setNote("");
        setInserted((n) => n + 1);
      }, [pick, note]);

      return h(
        "div",
        { className: "ab-root" },
        h(
          "div",
          { className: "ab-top" },
          h("span", { className: "ab-dot" + (connected ? "" : " bad"), title: connected ? "已连接浏览器" : "未连接" }),
          h("input", {
            className: "ab-url",
            value: url,
            placeholder: zh.urlPlaceholder,
            spellCheck: false,
            onChange: (e) => { urlTouched.current = true; setUrl(e.target.value); },
            onKeyDown: (e) => { if (e.key === "Enter") go(); }
          }),
          connected
            ? h("button", { className: "ab-btn ghost", type: "button", disabled: busy, onClick: go }, busy ? "…" : zh.go)
            : h("button", { className: "ab-btn", type: "button", disabled: busy, onClick: start }, busy ? "启动中…" : zh.start)
        ),
        h(
          "div",
          { className: "ab-stage" },
          connected
            ? h("img", {
                className: "ab-shot",
                ref: imgRef,
                src: `${ROUTES.shot}?t=${tick}`,
                alt: "annotate",
                draggable: false,
                onClick: onPick
              })
            : h(
                "div",
                { className: "ab-empty" },
                h("b", null, zh.loading),
                h("small", null, "点下面的按钮会拉起一个无头 Chrome（不弹窗口），然后在上面输入网址"),
                h("button", { className: "ab-btn", type: "button", disabled: busy, onClick: start }, busy ? "启动中…" : zh.start)
              )
        ),
        h(
          "div",
          { className: "ab-bottom" },
          err ? h("div", { className: "ab-picked", style: { color: "#ff9f0a" } }, err) : null,
          pick
            ? h("div", { className: "ab-picked" }, `${zh.picked}: ${pick.tag}${pick.id ? "#" + pick.id : ""} ${pick.text || ""}`)
            : h("div", { className: "ab-picked" }, zh.hint + (inserted ? ` · 已插入 ${inserted} 条` : "")),
          h("input", {
            className: "ab-note",
            placeholder: zh.note,
            value: note,
            onChange: (e) => setNote(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter" && pick) { e.preventDefault(); insert(); } }
          }),
          h(
            "div",
            { className: "ab-row" },
            h("button", { className: "ab-btn ghost", type: "button", onClick: () => { setPick(null); setNote(""); } }, zh.cancel),
            h("button", { className: "ab-btn", type: "button", disabled: !pick, onClick: insert }, zh.insert)
          )
        )
      );
    }

    /* ---------------- 隐藏的草稿写入器（dock 槽位） ---------------- */
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
      return null; // 不占位、不显示
    }

    function apply(ctx) {
      ensureStyle();
      // 草稿写入器：必须挂在 dock 槽位，才能拿到 inputActions
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          { name: "conversation.input.dock", id: "annotate-browser-writer-v1", order: 90, locale: NS },
          DraftWriter
        )
      );

      // 右侧面板：走 better-sidebar。注意必须用 ctx.inject 声明依赖，
      // 直接 ctx.get("betterSidebar") 在 cordis 里会抛「without inject」，被 try/catch 吞掉后
      // 就静默不注册（踩过）。
      const registerTab = (host) => {
        let sidebar = null;
        try { sidebar = host.get("betterSidebar"); } catch { sidebar = host.betterSidebar; }
        if (!sidebar || typeof sidebar.registerTab !== "function") return;
        host.effect(() =>
          sidebar.registerTab({
            id: TAB_ID,
            title: () => zh.title,
            order: 70,
            single: true,
            component: PanelTab
          })
        );
        host.effect(() => () => {
          try { sidebar.closeTab && sidebar.closeTab({ type: TAB_ID }); } catch {}
        });
      };
      if (typeof ctx.inject === "function") ctx.inject(["betterSidebar"], registerTab);
      else registerTab(ctx);
    }

    return { inject: ["slots", "locale"], apply };
  }
});

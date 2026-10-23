/**
 * dsh-annotate-browser 的客户端半：一个挂在输入框上方的「标注浏览器」胶囊。
 * 打开后显示 CDP 实时截图；点图中任意位置 → 取到该元素 → 写备注 → 插入草稿。
 * 只读写自己的路由，不依赖 dsh-browser-cdp 或 dsh-annotation。
 */
window.__ModuleLoader__.load({
  id: "dsh-annotate-browser",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = "annotateBrowser";
    const STYLE_ID = "annotate-browser-style";
    const ROUTES = {
      shot: "/api/annotate-browser/shot",
      element: "/api/annotate-browser/element",
      navigate: "/api/annotate-browser/navigate"
    };

    const zh = {
      chip: "标注浏览器",
      hint: "点图里要改的地方，写一句，插入对话",
      picked: "已选中",
      notePlaceholder: "这个元素要改成什么？",
      insert: "插入对话",
      cancel: "取消",
      close: "收起",
      navigate: "打开网址…",
      failed: "取元素失败"
    };

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        ".ab-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid rgba(128,128,128,.28);background:rgba(128,128,128,.12);font:12px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:pointer;color:inherit}",
        ".ab-chip:hover{background:rgba(128,128,128,.2)}",
        ".ab-panel{position:fixed;right:20px;bottom:110px;width:420px;max-height:70vh;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:14px;background:rgba(22,24,30,.96);color:#f5f5f7;border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 44px rgba(0,0,0,.5);z-index:2147482900;font:12px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}",
        ".ab-head{display:flex;align-items:center;gap:8px}",
        ".ab-head b{font-weight:600}",
        ".ab-btn{cursor:pointer;border:none;border-radius:8px;background:#0a84ff;color:#fff;font:inherit;font-weight:600;padding:5px 10px}",
        ".ab-btn.ghost{background:transparent;border:1px solid rgba(255,255,255,.16);font-weight:400}",
        ".ab-shot{width:100%;border-radius:9px;display:block;background:#000;cursor:crosshair}",
        ".ab-el{font-size:11px;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".ab-note{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:inherit;font:inherit;outline:none}",
        ".ab-row{display:flex;gap:6px;justify-content:flex-end}"
      ].join("\n");
      document.head.appendChild(style);
    }

    function Dock(props) {
      ensureStyle();
      const [open, setOpen] = useState(false);
      const [tick, setTick] = useState(0);
      const [pick, setPick] = useState(null);
      const [note, setNote] = useState("");
      const [err, setErr] = useState("");
      const imgRef = useRef(null);
      const live = typeof props.useInput === "function" ? props.useInput((s) => s) : null;

      useEffect(() => {
        if (!open) return undefined;
        const timer = setInterval(() => setTick((n) => n + 1), 1200);
        return () => clearInterval(timer);
      }, [open]);

      const src = open ? `${ROUTES.shot}?t=${tick}` : null;

      async function handleClick(ev) {
        const img = imgRef.current;
        if (!img) return;
        const rect = img.getBoundingClientRect();
        const scaleX = (img.naturalWidth || rect.width) / rect.width;
        const scaleY = (img.naturalHeight || rect.height) / rect.height;
        const x = Math.round((ev.clientX - rect.left) * scaleX);
        const y = Math.round((ev.clientY - rect.top) * scaleY);
        setErr("");
        try {
          const res = await fetch(ROUTES.element, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ x, y })
          }).then((r) => r.json());
          if (res && res.ok) setPick(res.element);
          else setErr(res && res.error ? res.error : zh.failed);
        } catch (error) {
          setErr(String(error && error.message ? error.message : error));
        }
      }

      function insert() {
        if (!pick) return;
        const actions = props.inputActions;
        const draft = live && typeof live.draft === "string" ? live.draft : "";
        const head = `〔标注〕${pick.tag || "element"}${pick.id ? "#" + pick.id : ""}`;
        const text = pick.text ? `「${String(pick.text).slice(0, 40)}」` : "";
        const where = `${pick.pageTitle || ""} ${pick.pageUrl || ""}`.trim();
        const line = `${head}${text}｜页面：${where}｜备注：${note.trim()}`;
        const next = draft ? draft + (draft.endsWith("\n") ? "" : "\n") + line : line;
        try {
          actions.setDraft(next);
        } catch {}
        setPick(null);
        setNote("");
        setOpen(false);
      }

      const chip = h(
        "button",
        { className: "ab-chip", type: "button", onClick: () => setOpen((v) => !v) },
        "🖱 " + zh.chip
      );

      if (!open) return chip;

      return h(
        React.Fragment,
        null,
        chip,
        h(
          "div",
          { className: "ab-panel" },
          h(
            "div",
            { className: "ab-head" },
            h("b", null, zh.chip),
            h("span", { style: { flex: 1, opacity: 0.6 } }, zh.hint)
          ),
          src ? h("img", { className: "ab-shot", ref: imgRef, src, alt: "annotate", onClick: handleClick, draggable: false }) : null,
          pick ? h("div", { className: "ab-el" }, `${zh.picked}: ${pick.tag}${pick.id ? "#" + pick.id : ""} ${pick.text || ""}`) : null,
          err ? h("div", { className: "ab-el", style: { color: "#ff9f0a" } }, err) : null,
          h("input", {
            className: "ab-note",
            placeholder: zh.notePlaceholder,
            value: note,
            onChange: (e) => setNote(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter" && pick) {
                e.preventDefault();
                insert();
              }
            }
          }),
          h(
            "div",
            { className: "ab-row" },
            h("button", { className: "ab-btn ghost", type: "button", onClick: () => setOpen(false) }, zh.close),
            h("button", { className: "ab-btn", type: "button", disabled: !pick, onClick: insert }, zh.insert)
          )
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.input.dock",
            id: "annotate-browser-dock-v1",
            order: -30,
            locale: NS
          },
          Dock
        )
      );
    }

    return { inject: ["slots", "locale"], apply };
  }
});

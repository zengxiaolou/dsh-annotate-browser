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
      status: "/api/annotate-browser/status"
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
      loading: "连接中…"
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
        ".ab-root{display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;padding:10px;box-sizing:border-box;color:inherit;font:12px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}",
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
      const [inserted, setInserted] = useState(0);
      const imgRef = useRef(null);

      useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), 1200);
        return () => clearInterval(timer);
      }, []);

      useEffect(() => {
        let alive = true;
        fetch(`${ROUTES.status}?t=${tick}`, { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => { if (alive && d) { setPage(d.page || null); setErr(d.ok ? "" : d.lastError || ""); } })
          .catch(() => {});
        return () => { alive = false; };
      }, [tick]);

      const src = `${ROUTES.shot}?t=${tick}`;

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
          { className: "ab-bar" },
          h("span", { className: "ab-dot" + (page ? "" : " bad") }),
          h("span", { className: "ab-meta" }, page ? `${page.title || ""} ${page.url || ""}`.trim() : zh.loading)
        ),
        h(
          "div",
          { className: "ab-stage" },
          h("img", {
            className: "ab-shot",
            ref: imgRef,
            src,
            alt: "annotate",
            draggable: false,
            onClick: onPick
          })
        ),
        err ? h("div", { className: "ab-picked", style: { color: "#ff9f0a" } }, err) : null,
        pick
          ? h("div", { className: "ab-picked" }, `${zh.picked}: ${pick.tag}${pick.id ? "#" + pick.id : ""} ${pick.text || ""}`)
          : h("div", { className: "ab-picked" }, zh.hint + (inserted ? ` · ${zh.inserted.replace("×", String(inserted))}` : "")),
        h("input", {
          className: "ab-note",
          placeholder: zh.note,
          value: note,
          onChange: (e) => setNote(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && pick) { e.preventDefault(); insert(); }
          }
        }),
        h(
          "div",
          { className: "ab-bar", style: { justifyContent: "flex-end" } },
          h("button", { className: "ab-btn ghost", type: "button", onClick: () => { setPick(null); setNote(""); } }, zh.cancel),
          h("button", { className: "ab-btn", type: "button", disabled: !pick, onClick: insert }, zh.insert)
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

      // 右侧面板：有 better-sidebar 就注册 Tab
      let sidebar = null;
      try { sidebar = typeof ctx.get === "function" ? ctx.get("betterSidebar") : null; } catch {}
      if (sidebar && typeof sidebar.registerTab === "function") {
        ctx.effect(() =>
          sidebar.registerTab({
            id: TAB_ID,
            title: () => zh.title,
            order: 70,
            single: true,
            component: PanelTab
          })
        );
        ctx.effect(() => () => {
          try { sidebar.closeTab && sidebar.closeTab({ type: TAB_ID }); } catch {}
        });
      }
    }

    return { inject: ["slots", "locale"], apply };
  }
});

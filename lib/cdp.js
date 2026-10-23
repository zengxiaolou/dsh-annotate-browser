/**
 * 极简 CDP 客户端：只用 Node 22+ 的全局 WebSocket，零依赖。
 * 浏览器端（browser 级）连接 + 每页一个扁平会话（flatten sessionId）。
 */
export class CdpClient {
  constructor(wsUrl, { timeoutMs = 8000 } = {}) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.pending = new Map();
    this.ws = null;
    this.listeners = new Map(); // method -> Set<fn>
  }

  async connect() {
    if (this.ws) return this;
    if (typeof WebSocket !== "function") throw new Error("全局 WebSocket 不可用（需要 Node 22+）");
    const ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 连接超时: ${this.wsUrl}`)), this.timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`CDP 连接失败: ${this.wsUrl}`)); }, { once: true });
    });
    ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    this.ws = ws;
    return this;
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : String(raw)); } catch { return; }
    if (msg.id == null) {
      // CDP 事件（没有 id）
      if (msg.method && this.listeners.has(msg.method)) {
        for (const fn of this.listeners.get(msg.method)) {
          try { fn(msg.params || {}, msg.sessionId || ""); } catch {}
        }
      }
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(`${msg.error.message || "CDP error"} (${msg.error.code})`));
    else entry.resolve(msg.result);
  }

  /** 订阅 CDP 事件，返回取消函数。 */
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => {
      const set = this.listeners.get(method);
      if (set) set.delete(handler);
    };
  }

  send(method, params = {}, sessionId = undefined) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("CDP 未连接");
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** 附到一个 page target，返回 flatten 后的 sessionId。 */
  async attachPage({ matchUrl = "", createUrl = "about:blank" } = {}) {
    const listPages = async () => {
      const { targetInfos = [] } = await this.send("Target.getTargets");
      return targetInfos.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
    };
    let pages = await listPages();
    // 无头/`--no-startup-window` 启动的 Chrome 可能一个页面都没有：自己开一个
    if (pages.length === 0) {
      await this.send("Target.createTarget", { url: createUrl });
      pages = await listPages();
    }
    const target = (matchUrl && pages.find((t) => t.url.includes(matchUrl))) || pages[0];
    if (!target) throw new Error("没有可用的页面 target（createTarget 后仍为空）");
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    return { sessionId, targetId: target.targetId, url: target.url, title: target.title };
  }

  /** 列出所有 page target（不附着）。 */
  async listPages() {
    const { targetInfos = [] } = await this.send("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
  }

  /** 自己开一个新页面并附着（插件独占，不去抢用户/别的插件的标签页）。 */
  async createPage(url = "about:blank") {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return { sessionId, targetId, url, title: "" };
  }

  /** 附着一个已存在的 target（重连时用）。 */
  async attachTarget(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return { sessionId, targetId };
  }

  /** 共享的“命中栈穿透”脚本：返回挑中的 DOM 节点本身（Overlay 与取元素都用它，保证一致）。 */
  #pickExpr(x, y) {
    return `(() => {
      const x = ${Number(x)}, y = ${Number(y)};
      const stack = (document.elementsFromPoint(x, y) || []).filter(Boolean);
      const vw = window.innerWidth || 1, vh = window.innerHeight || 1, vArea = vw * vh;
      const info = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const area = Math.max(0, r.width) * Math.max(0, r.height);
        const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        const interactive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)$/.test(el.tagName) || el.getAttribute("role") === "button";
        const positioned = cs.position === "absolute" || cs.position === "fixed";
        const coversAll = area >= vArea * 0.5;
        const skip = (positioned && coversAll && !interactive && text.length === 0) || (coversAll && !interactive);
        return { area, text, interactive, skip };
      };
      const cands = stack.filter((e) => !["HTML", "BODY"].includes(e.tagName)).map((el) => ({ el, i: info(el) }));
      let chosen = cands.find(({ i }) => !i.skip && (i.interactive || i.area < vArea * 0.5));
      if (!chosen) {
        const withText = cands.filter(({ i }) => !i.skip && i.text.length > 0).sort((a, b) => a.i.area - b.i.area);
        chosen = withText[0];
      }
      if (!chosen) chosen = cands.find(({ i }) => !i.skip) || { el: stack.find((e) => !["HTML", "BODY"].includes(e.tagName)) || document.body };
      return chosen.el;
    })()`;
  }

  /** 坐标处挑中的元素句柄（不序列化，给 Overlay 用）。 */
  async pickHandle(sessionId, x, y) {
    try { await this.send("DOM.enable", {}, sessionId); } catch {}
    try { await this.send("Overlay.enable", {}, sessionId); } catch {}
    const res = await this.send("Runtime.evaluate", { expression: this.#pickExpr(x, y), returnByValue: false }, sessionId);
    const objectId = res && res.result && res.result.objectId;
    if (!objectId) return null;
    return { objectId };
  }

  /** DevTools 式高亮：白框 + 元素信息浮层，用和点选同一套穿透规则。 */
  async highlightAt(sessionId, x, y) {
    try {
      const handle = await this.pickHandle(sessionId, x, y);
      if (!handle) {
        await this.send("Overlay.hideHighlight", {}, sessionId);
        return { hit: false };
      }
      await this.send("Overlay.highlightNode", {
        objectId: handle.objectId,
        highlightConfig: {
          showInfo: true,
          // 白框在浅色页面上会“隐身”，用 DevTools 同款蓝框 + 淡蓝填充，深浅背景都清楚
          contentColor: { r: 88, g: 166, b: 255, a: 0.22 },
          paddingColor: { r: 63, g: 185, b: 80, a: 0.14 },
          borderColor: { r: 88, g: 166, b: 255, a: 0.95 },
          marginColor: { r: 210, g: 153, b: 34, a: 0.14 }
        }
      }, sessionId);
      return { hit: true };
    } catch (error) {
      return { hit: false, error: String(error?.message || error) };
    }
  }

  async hideHighlight(sessionId) {
    try { await this.send("Overlay.hideHighlight", {}, sessionId); } catch {}
  }

  /** 坐标 → 元素信息（和高亮同一套选择逻辑），并带足够的上下文让上游能定位到源码。 */
  async elementAt(sessionId, x, y) {
    const handle = await this.pickHandle(sessionId, x, y);
    if (!handle) throw new Error("元素解析失败：该坐标没有命中元素");
    const fn = `function () {
      var el = this;
      var pick = function (a, n) { return a ? String(a).trim().slice(0, n || 100) : ""; };
      var cls = typeof el.className === "string" ? el.className : (el.className && el.className.baseVal) || "";
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);

      // 身份优先级：data-testid/data-test > id > data-ab-id > nth-child 路径
      var testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-test-id") || "";
      if (!el.getAttribute("data-ab-id")) {
        el.setAttribute("data-ab-id", "ab-" + Math.random().toString(36).slice(2, 9));
      }
      var abId = el.getAttribute("data-ab-id");

      var selector = (function () {
        if (testId) return '[data-testid="' + testId + '"]';
        if (el.id) return "#" + CSS.escape(el.id);
        if (abId) return '[data-ab-id="' + abId + '"]';
        var parts = [], cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 6) {
          var part = cur.tagName.toLowerCase();
          if (cur.parentElement) {
            var idx = Array.prototype.indexOf.call(cur.parentElement.children, cur) + 1;
            part += ":nth-child(" + idx + ")";
          }
          parts.unshift(part);
          if (cur.parentElement === document.body) break;
          cur = cur.parentElement;
        }
        return parts.join(" > ");
      })();

      // React/Vue/Svelte 开发态源码位置 + 组件栈（借鉴 react-grab 的 component stack）
      var source = null, owner = null, stack = [];
      try {
        var key = Object.keys(el).find(function (k) { return k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0; });
        if (key) {
          var fiber = el[key], depth = 0;
          // 每个 fiber 自身的 _debugSource 才是“该组件 JSX 所在位置”，不要用 _debugOwner 的
          while (fiber && depth < 60) {
            var ft = fiber.type;
            var nm = ft && (ft.displayName || ft.name);
            var ds = fiber._debugSource;
            if (nm && !owner) owner = nm;
            if (!source && ds && ds.fileName) {
              source = { file: ds.fileName, line: ds.lineNumber, col: ds.columnNumber };
            }
            if (nm && ds && ds.fileName && stack.length < 5) {
              var dup = false;
              for (var si = 0; si < stack.length; si++) if (stack[si].name === nm) { dup = true; break; }
              // 注意：fiber._debugSource 是「该组件被使用的位置」，不是定义位置；
              // 跳转用 elementAt 返回的 source，这里只作为调用链线索。
              if (!dup) stack.push({ name: nm, usedAt: { file: ds.fileName, line: ds.lineNumber || null } });
            }
            fiber = fiber.return; depth++;
          }
        }
        if (!source) {
          var vue = el.__vueParentComponent;
          if (vue) {
            var vt = vue.type || {};
            var vfile = vt.__file || (vue.parent && vue.parent.type && vue.parent.type.__file);
            if (vfile) source = { file: vfile, line: null, col: null };
            owner = owner || vt.__name || vt.name || null;
          }
        }
        if (!source && el.__svelte_meta && el.__svelte_meta.loc) {
          source = { file: el.__svelte_meta.loc.file, line: el.__svelte_meta.loc.line, col: el.__svelte_meta.loc.column };
        }
      } catch (e) {}

      // 父级链（3 层）与容器语义
      var chain = [], cur2 = el.parentElement, up = 0;
      while (cur2 && up < 3) {
        var c2 = typeof cur2.className === "string" ? cur2.className : "";
        chain.push(cur2.tagName.toLowerCase() + (cur2.id ? "#" + cur2.id : "") + (c2 ? "." + String(c2).split(/\s+/).slice(0, 2).join(".") : ""));
        cur2 = cur2.parentElement; up++;
      }
      var parentText = pick(el.parentElement ? el.parentElement.innerText : "", 120);
      var dataAttrs = {};
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        if (a.name.indexOf("data-") === 0 || a.name === "href" || a.name === "src" || a.name === "type" || a.name === "name" || a.name === "placeholder") {
          dataAttrs[a.name] = pick(a.value, 120);
        }
      }
      return JSON.stringify({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        classes: pick(cls, 120),
        cls: pick(cls, 120),
        role: el.getAttribute("role") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        selector: selector,
        abId: abId,
        testId: testId,
        attrs: dataAttrs,
        text: pick(el.innerText || el.value || el.getAttribute("aria-label") || "", 120),
        context: parentText,
        parents: chain,
        html: pick(el.outerHTML, 300),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollY: Math.round(window.scrollY) },
        styles: {
          display: cs.display, position: cs.position, color: cs.color, background: cs.backgroundColor,
          font: pick(cs.fontSize + " / " + cs.fontWeight + " / " + cs.fontFamily, 60),
          padding: cs.padding, margin: cs.margin, borderRadius: cs.borderRadius
        },
        framework: { source: source, component: owner, stack: stack },
        page: { url: location.href, title: document.title, route: location.pathname + location.search }
      });
    }`;
    const res = await this.send("Runtime.callFunctionOn", {
      objectId: handle.objectId,
      functionDeclaration: fn,
      returnByValue: true
    }, sessionId);
    const value = res && res.result && res.result.value;
    if (!value) throw new Error("元素信息为空");
    return JSON.parse(value);
  }

  /**
   * 在页面里安装「标注层」：固定层 + 全局 API。
   * 标记按 CSS 选择器重新定位，所以滚动/重排后仍贴住元素（不靠 CDP 回读坐标）。
   */
  async installMarks(sessionId) {
    const engine = `(() => {
      if (window.__abMarks) return 'ready';
      const LAYER = '__ab-marks-layer';
      let layer = document.getElementById(LAYER);
      if (!layer) {
        layer = document.createElement('div');
        layer.id = LAYER;
        layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483400;';
        (document.documentElement || document.body).appendChild(layer);
      }
      window.__abCssPath = function (el) {
        if (!el || !el.tagName) return '';
        var testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
        if (testId) return '[data-testid="' + testId + '"]';
        if (el.id) return '#' + CSS.escape(el.id);
        if (!el.getAttribute('data-ab-id')) {
          el.setAttribute('data-ab-id', 'ab-' + Math.random().toString(36).slice(2, 9));
        }
        return '[data-ab-id="' + el.getAttribute('data-ab-id') + '"]';
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 6) {
          let part = cur.tagName.toLowerCase();
          if (cur.parentElement) {
            const idx = Array.prototype.indexOf.call(cur.parentElement.children, cur) + 1;
            part += ':nth-child(' + idx + ')';
          }
          parts.unshift(part);
          if (cur.parentElement === document.body) break;
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const items = [];
      const draw = () => {
        layer.textContent = '';
        for (const it of items) {
          let el = null;
          try { el = document.querySelector(it.selector); } catch (e) { el = null; }
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const box = document.createElement('div');
          box.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;'
            + 'left:' + Math.round(r.x) + 'px;top:' + Math.round(r.y) + 'px;'
            + 'width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px;'
            + 'outline:2px solid rgba(88,166,255,.95);outline-offset:0;border-radius:3px;'
            + 'background:rgba(88,166,255,.10);';
          const badge = document.createElement('div');
          // 备注气泡默认隐藏：只有把鼠标移到编号钉上才显示（标多个时不挡页面）
          if (it.note) {
            const tip0 = document.createElement('div');
            tip0.textContent = it.note;
            tip0.style.cssText = 'position:absolute;left:0;top:calc(100% + 4px);max-width:260px;padding:4px 8px;'
              + 'border-radius:6px;background:rgba(13,17,23,.96);border:1px solid rgba(88,166,255,.5);color:#e6edf3;'
              + 'font:11px/1.45 -apple-system,system-ui,sans-serif;white-space:pre-wrap;display:none;';
            box.appendChild(tip0);
            box.dataset.hasTip = '1';
          }
          badge.textContent = String(it.n);
          badge.style.cssText = 'position:absolute;left:-10px;top:-10px;min-width:20px;height:20px;border-radius:10px;'
            + 'background:#58a6ff;color:#fff;font:600 11px/20px -apple-system,system-ui,sans-serif;'
            + 'text-align:center;padding:0 5px;box-sizing:border-box;box-shadow:0 2px 8px rgba(1,4,9,.6);'
            + 'pointer-events:auto;cursor:default;';
          if (box.dataset.hasTip) {
            const tipEl = box.querySelector('div');
            badge.addEventListener('mouseenter', () => { if (tipEl) tipEl.style.display = 'block'; });
            badge.addEventListener('mouseleave', () => { if (tipEl) tipEl.style.display = 'none'; });
          }
          box.appendChild(badge);
          layer.appendChild(box);
        }
      };
      window.__abMarks = {
        items,
        add(it) { items.push(it); draw(); return items.length; },
        clear() { items.length = 0; draw(); },
        redraw: draw,
        list() { return items.slice(); }
      };
      window.addEventListener('scroll', draw, { passive: true, capture: true });
      window.addEventListener('resize', draw);
      return 'installed';
    })()`;
    await this.send("Runtime.evaluate", { expression: engine, returnByValue: true }, sessionId);
    return true;
  }

  /** 在坐标处取元素并留下编号标注（选择器 + 备注）。 */
  async addMark(sessionId, { x, y, n, note = "" }) {
    await this.installMarks(sessionId);
    const handle = await this.pickHandle(sessionId, x, y);
    if (!handle) return { ok: false, error: "该坐标没有命中元素" };
    const fn = `function (n, note) {
      var sel = window.__abCssPath ? window.__abCssPath(this) : '';
      if (!sel) return JSON.stringify({ ok: false });
      var count = window.__abMarks.add({ n: n, selector: sel, note: note || '' });
      return JSON.stringify({ ok: true, selector: sel, count: count, tag: this.tagName });
    }`;
    const res = await this.send("Runtime.callFunctionOn", {
      objectId: handle.objectId,
      functionDeclaration: fn,
      arguments: [{ value: n }, { value: note }],
      returnByValue: true
    }, sessionId);
    const value = res && res.result && res.result.value;
    return value ? JSON.parse(value) : { ok: false, error: "标注写入失败" };
  }

  async clearMarks(sessionId) {
    try {
      await this.send("Runtime.evaluate", { expression: "window.__abMarks ? (window.__abMarks.clear(), 'cleared') : 'none'", returnByValue: true }, sessionId);
    } catch {}
  }

  /** 截图：默认 optimizeForSpeed，代价明显低于整帧高质量编码。 */
  async screenshot(sessionId, { format = "png", quality, optimizeForSpeed = true } = {}) {
    const args = { format, optimizeForSpeed };
    if (format === "jpeg" && quality) args.quality = quality;
    const { data } = await this.send("Page.captureScreenshot", args, sessionId);
    return data;
  }

  close() {
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
  }
}

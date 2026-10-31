// Content script: finds the word under the cursor (or the selected phrase),
// asks the background worker for a translation and shows it in a tooltip.
(() => {
  if (window.__buryadHoverTranslator) return;
  window.__buryadHoverTranslator = true;

  const WORD_CHAR = /[\p{L}\p{M}'’-]/u;
  const CYRILLIC = /\p{Script=Cyrillic}/u;
  const MAX_SELECTION = 200;
  const MAX_SHOWN = 3;

  let cfg = { enabled: true, direction: "bua-ru", hoverDelay: 300, modifier: "none" };
  chrome.storage.sync.get(cfg).then((v) => Object.assign(cfg, v));
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "sync") return;
    for (const k in c) cfg[k] = c[k].newValue;
    if (!cfg.enabled) hide();
  });

  // ---- tooltip (shadow DOM keeps page CSS out) ----
  let host, tip;
  function ensureTip() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .tip{position:fixed;max-width:340px;padding:8px 10px;border-radius:8px;
        background:#1f2430;color:#f2f4f8;font:13px/1.4 system-ui,sans-serif;
        box-shadow:0 4px 18px rgba(0,0,0,.35);white-space:normal;overflow-wrap:anywhere}
      .w{font-weight:600;color:#ffd479}
      .stem{opacity:.6;font-size:11px;margin-left:4px}
      .t{margin:2px 0 6px}.t:last-child{margin-bottom:0}
      .full{margin-top:4px;padding-top:6px;border-top:1px solid #444b5c}
      .src{opacity:.55;font-size:11px}
      .miss{opacity:.6;font-style:italic}`;
    tip = document.createElement("div");
    tip.className = "tip";
    root.append(style, tip);
    document.documentElement.append(host);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render(res) {
    tip.replaceChildren();
    if (!res?.ok) {
      tip.append(el("div", "miss", "Translation unavailable"));
      return;
    }
    if (!res.items.length && !res.full) {
      tip.append(el("div", "miss", "Not found in dictionary"));
      return;
    }
    for (const it of res.items) {
      const row = el("div", "t");
      const w = el("span", "w", it.word);
      row.append(w);
      if (it.stem) row.append(el("span", "stem", `≈ ${it.stem}`));
      row.append(document.createElement("br"));
      const shown = it.translations.slice(0, MAX_SHOWN).join(" • ");
      row.append(document.createTextNode(shown));
      tip.append(row);
    }
    if (res.full) {
      const f = el("div", "full", res.full);
      f.append(document.createElement("br"), el("span", "src", "Google Translate"));
      tip.append(f);
    } else if (res.missing) {
      tip.append(el("div", "miss", `${res.missing} word(s) not found`));
    }
  }

  function position(rect) {
    const m = 8;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.min(Math.max(m, rect.left), innerWidth - tw - m);
    let y = rect.bottom + m;
    if (y + th > innerHeight - m) y = Math.max(m, rect.top - th - m);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  function hide() {
    clearTimeout(timer);
    token++;
    current = null;
    if (tip) tip.style.display = "none";
  }

  // ---- lookup ----
  let timer = 0, token = 0, current = null;

  function show(text, rect, key) {
    const my = ++token;
    current = key;
    chrome.runtime.sendMessage({ type: "translate", text }).then(
      (res) => {
        if (my !== token) return; // stale
        ensureTip();
        tip.style.display = "block";
        render(res);
        position(rect);
      },
      () => {} // extension reloaded / worker unavailable
    );
  }

  function wordAtPoint(x, y) {
    let node, offset;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      ({ offsetNode: node, offset } = p);
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return null;
      ({ startContainer: node, startOffset: offset } = r);
    } else return null;
    if (node?.nodeType !== Node.TEXT_NODE) return null;
    const s = node.data;
    let a = offset, b = offset;
    while (a > 0 && WORD_CHAR.test(s[a - 1])) a--;
    while (b < s.length && WORD_CHAR.test(s[b])) b++;
    const word = s.slice(a, b).replace(/^['’-]+|['’-]+$/g, "");
    if (!word || !CYRILLIC.test(word)) return null;
    const range = document.createRange();
    range.setStart(node, a);
    range.setEnd(node, b);
    // caret APIs snap to the nearest text; require the pointer to be on the word itself
    const hit = [...range.getClientRects()].find(
      (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1
    );
    return hit ? { word, rect: hit, key: `${node.nodeValue.length}:${a}:${b}:${word}` } : null;
  }

  function modifierOk(e) {
    return cfg.modifier === "none" || e.getModifierState(cfg.modifier);
  }

  function inEditable(t) {
    return t instanceof Element && !!t.closest("input,textarea,select,[contenteditable=''],[contenteditable='true']");
  }

  addEventListener(
    "mousemove",
    (e) => {
      if (!cfg.enabled || e.buttons || !modifierOk(e)) return;
      if (host && e.composedPath().includes(host)) return;
      const sel = getSelection();
      if (sel && !sel.isCollapsed) return; // a selection tooltip takes precedence
      clearTimeout(timer);
      if (inEditable(e.target)) return hide();
      const { clientX: x, clientY: y } = e;
      timer = setTimeout(() => {
        const hit = wordAtPoint(x, y);
        if (!hit) return hide();
        if (hit.key !== current) show(hit.word, hit.rect, hit.key);
      }, cfg.hoverDelay);
    },
    { passive: true }
  );

  addEventListener("mouseup", (e) => {
    if (!cfg.enabled || inEditable(e.target)) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!text || text.length > MAX_SELECTION || !CYRILLIC.test(text)) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      show(text, rect, `sel:${text}`);
    }, 0);
  });

  addEventListener("mousedown", () => hide(), true);
  addEventListener("scroll", hide, { capture: true, passive: true });
  addEventListener("keydown", (e) => e.key === "Escape" && hide(), true);
  document.addEventListener("mouseleave", hide);
})();

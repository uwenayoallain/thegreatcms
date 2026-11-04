/**
 * The inspector the dev server adds to a page while the studio frames it: it
 * finds where each field renders, outlines the page's sections, and tells the
 * studio what was clicked. Plain JavaScript in a string, because it is handed
 * to the browser as-is and never built; nothing in it runs outside a frame.
 */

export const INSPECT_SCRIPT = String.raw`
if (window.top !== window.self) {
  (() => {
    const DOC = document;
    const ATTR = "data-greatcms-field";
    // A dev server that does not watch content says so here, and the studio reloads the page after each draft.
    const WATCHED = !(window.__greatcmsUnwatched === true || DOC.documentElement.hasAttribute("data-greatcms-unwatched"));
    const BLOCK_ATTR = "data-greatcms-block";
    let studio = null;
    let origin = "*";
    let fields = [];
    let matches = new Map();
    let blocks = new Map();
    let byElement = new WeakMap();
    let blockOf = new WeakMap();
    let mode = { select: false, sections: false };
    let hovered = null;

    const normalize = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const stem = (src) => {
      const name = String(src ?? "").split("?")[0].split("/").pop() || "";
      return name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
    };
    const textOf = (html) => {
      const parsed = new DOMParser().parseFromString(String(html ?? ""), "text/html");
      return parsed.body;
    };
    const skip = (element) =>
      element.closest("script, style, template, noscript, greatcms-overlay, astro-dev-toolbar");

    // The overlay lives in a shadow root on an inert, hidden host: the page's CSS cannot restyle
    // it, its selectors cannot match it, and assistive technology never meets it.
    const host = DOC.createElement("greatcms-overlay");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    host.style.cssText = "all:initial;position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483646;pointer-events:none;view-transition-name:none";
    const shadow = host.attachShadow({ mode: "open" });
    const style = DOC.createElement("style");
    style.textContent = [
      ".gc-box{position:absolute;box-sizing:border-box;border:2px solid #0d7a5f;border-radius:4px;background:rgb(13 122 95 / .07);transition:top .12s,left .12s,width .12s,height .12s;opacity:0}",
      ".gc-box.is-on{opacity:1}",
      ".gc-box.is-block{border-style:dashed;background:transparent}",
      ".gc-tag{position:absolute;left:-2px;top:-2px;transform:translateY(-100%);padding:4px 7px;border-radius:4px 4px 4px 0;background:#0d7a5f;color:#fff;font:600 11px/1 system-ui,sans-serif;white-space:nowrap;max-width:40ch;overflow:hidden;text-overflow:ellipsis}",
      ".gc-tag.is-inside{transform:none;border-radius:0 0 4px 0}",
      ".gc-section{position:absolute;box-sizing:border-box;border:1px dashed rgb(13 122 95 / .55);border-radius:4px}",
      ".gc-section .gc-tag{background:rgb(13 122 95 / .9);transform:none;border-radius:0 0 4px 0;left:0;top:0}",
      ".gc-flash{animation:gc-flash 1.4s ease-out both}",
      "@keyframes gc-flash{0%{box-shadow:0 0 0 0 rgb(13 122 95 / .5)}100%{box-shadow:0 0 0 14px rgb(13 122 95 / 0)}}",
      "@media (prefers-reduced-motion:reduce){.gc-box{transition:none}.gc-flash{animation:none}}",
    ].join("\n");
    const box = DOC.createElement("div");
    box.className = "gc-box";
    const tag = DOC.createElement("span");
    tag.className = "gc-tag";
    box.append(tag);
    const sections = DOC.createElement("div");
    shadow.append(style, box, sections);
    // The crosshair is the one rule that has to reach the page itself.
    const pointer = DOC.createElement("style");
    pointer.textContent = "html[data-greatcms-select],html[data-greatcms-select] *{cursor:crosshair!important}";
    const mount = () => {
      if (!host.isConnected) DOC.body.append(host);
    };
    const restore = () => {
      if (!pointer.isConnected) DOC.head.append(pointer);
      DOC.documentElement.toggleAttribute("data-greatcms-select", mode.select);
    };

    const rectOf = (element) => {
      const r = element.getBoundingClientRect();
      return {
        top: r.top + window.scrollY,
        left: r.left + window.scrollX,
        width: r.width,
        height: r.height,
      };
    };
    const place = (node, rect) => {
      node.style.top = rect.top + "px";
      node.style.left = rect.left + "px";
      node.style.width = rect.width + "px";
      node.style.height = rect.height + "px";
    };

    // Which element shows a field: an explicit data attribute wins, then the deepest
    // element whose text is exactly the value, then an image whose file is the value's.
    function index() {
      matches = new Map();
      byElement = new WeakMap();
      const texts = new Map();
      const remember = (text, element) => {
        if (!text || text.length > 4000) return;
        const list = texts.get(text) ?? [];
        if (!list.includes(element)) list.push(element);
        texts.set(text, list);
      };
      for (const element of DOC.body.querySelectorAll("*")) {
        if (skip(element) || element.children.length > 40) continue;
        remember(normalize(element.textContent), element);
        // A link may carry words only screen readers get; its own text is what the value matches.
        const own = normalize([...element.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join(" "));
        if (own) remember(own, element);
      }
      // The same words in the nav and in the page are usually the page's: prefer what is in <main>.
      const deepest = (list) => {
        const inner = list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
        return [...inner.filter((el) => el.closest("main")), ...inner.filter((el) => !el.closest("main"))];
      };
      const images = [...DOC.images];
      for (const field of fields) {
        let found = DOC.querySelector("[" + ATTR + '="' + CSS.escape(field.dotted) + '"]');
        if (!found && field.kind === "image") {
          const want = stem(field.value);
          found = want ? images.find((img) => stem(img.currentSrc || img.src).startsWith(want) || [...img.closest("picture")?.querySelectorAll("source") ?? []].some((s) => s.srcset.includes(want))) : null;
          if (found && found.closest("picture")) found = found.closest("picture");
        } else if (!found) {
          const value = field.kind === "richtext" ? normalize(textOf(field.value).textContent) : normalize(field.value);
          if (value.length < 2) continue;
          const list = texts.get(value);
          if (list) found = deepest(list)[0];
          else if (field.kind === "richtext") {
            // Rich text that the site splits up: find its first paragraph and take the parent.
            const first = normalize(textOf(field.value).firstElementChild?.textContent);
            const some = first.length > 1 ? texts.get(first) : null;
            if (some) found = deepest(some)[0]?.parentElement ?? null;
          }
        }
        if (!found || byElement.has(found)) continue;
        matches.set(field.path, found);
        byElement.set(found, field);
      }
      group();
    }

    // A section is where a block's fields meet: their lowest common ancestor, lifted as far
    // as the nearest sectioning element unless that would swallow another block's fields,
    // so three cards in one grid outline as three sections and a lone block as its whole section.
    function group() {
      blocks = new Map();
      blockOf = new WeakMap();
      const members = new Map();
      const owner = new Map();
      for (const field of fields) {
        if (!field.block) continue;
        const element = matches.get(field.path);
        if (!element) continue;
        const list = members.get(field.block.id) ?? [];
        list.push(element);
        members.set(field.block.id, list);
        owner.set(element, field.block.id);
      }
      const foreign = (node, id) => [...owner].some(([element, other]) => other !== id && node.contains(element));
      for (const field of fields) {
        if (!field.block || blocks.has(field.block.id)) continue;
        const id = field.block.id;
        let root = DOC.querySelector("[" + BLOCK_ATTR + '="' + CSS.escape(id) + '"]');
        if (!root) {
          const list = members.get(id);
          if (!list) continue;
          root = list.reduce((a, b) => ancestor(a, b));
          const ceiling = root.closest("section, article, header, footer, nav, aside, [data-greatcms-block]") ?? DOC.body;
          while (root !== ceiling && root.parentElement && root.parentElement !== DOC.body && !foreign(root.parentElement, id)) {
            root = root.parentElement;
          }
          if (root === DOC.body) continue;
        }
        blocks.set(id, { element: root, block: field.block });
        blockOf.set(root, field.block);
      }
      // A page made of sections is its sections; the whole-page outline would only sit over them.
      if (blocks.size > 1 && blocks.has("region")) {
        blockOf.delete(blocks.get("region").element);
        blocks.delete("region");
      }
      drawSections();
    }
    const ancestor = (a, b) => {
      let node = a;
      while (node && !node.contains(b)) node = node.parentElement;
      return node ?? DOC.body;
    };

    function drawSections() {
      sections.replaceChildren();
      if (!mode.sections) return;
      mount();
      for (const { element, block } of blocks.values()) {
        const node = DOC.createElement("div");
        node.className = "gc-section";
        const label = DOC.createElement("span");
        label.className = "gc-tag";
        label.textContent = block.label;
        node.append(label);
        place(node, rectOf(element));
        sections.append(node);
      }
    }

    function show(element, label, isBlock) {
      mount();
      const rect = rectOf(element);
      place(box, rect);
      box.classList.toggle("is-block", Boolean(isBlock));
      tag.classList.toggle("is-inside", rect.top - window.scrollY < 28);
      tag.textContent = label;
      box.classList.add("is-on");
    }
    const hide = () => {
      box.classList.remove("is-on", "gc-flash");
      hovered = null;
    };

    // What sits under the pointer: a field first, then the section it is in.
    function target(element) {
      for (let node = element; node && node !== DOC.body; node = node.parentElement) {
        const field = byElement.get(node);
        if (field) return { element: node, label: field.label, field };
      }
      for (let node = element; node && node !== DOC.body; node = node.parentElement) {
        const block = blockOf.get(node);
        if (block) return { element: node, label: block.label, block };
      }
      return null;
    }

    function onMove(event) {
      if (!mode.select) return;
      const hit = target(event.target);
      if (!hit) return hide();
      if (hovered === hit.element) return;
      hovered = hit.element;
      show(hit.element, hit.label, Boolean(hit.block));
    }
    function onClick(event) {
      if (!mode.select) return;
      const hit = target(event.target);
      event.preventDefault();
      event.stopPropagation();
      if (!hit) return;
      send(hit.field ? { greatcms: "pick", path: hit.field.path } : { greatcms: "pick", block: hit.block.id });
    }
    function onKey(event) {
      if (mode.select && event.key === "Escape") send({ greatcms: "mode", select: false });
    }

    function focus(path) {
      const element = matches.get(path) ?? blocks.get(path)?.element;
      if (!element) return;
      const field = byElement.get(element);
      element.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      show(element, field ? field.label : (blockOf.get(element)?.label ?? ""), !field);
      box.classList.remove("gc-flash");
      void box.offsetWidth;
      box.classList.add("gc-flash");
      window.clearTimeout(focus.timer);
      focus.timer = window.setTimeout(() => { if (!mode.select) hide(); }, 1800);
    }

    function send(message) {
      if (studio) studio.postMessage(message, origin);
    }
    function report() {
      send({ greatcms: "matched", fields: matches.size, of: fields.length, blocks: blocks.size });
    }

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || typeof data !== "object" || typeof data.greatcms !== "string") return;
      if (event.source !== window.parent) return;
      studio = event.source;
      origin = event.origin;
      if (data.greatcms === "fields" && Array.isArray(data.fields)) {
        fields = data.fields.filter((f) => f && typeof f.path === "string");
        index();
        report();
      } else if (data.greatcms === "mode") {
        if (typeof data.select === "boolean") mode.select = data.select;
        if (typeof data.sections === "boolean") mode.sections = data.sections;
        restore();
        if (!mode.select) hide();
        drawSections();
      } else if (data.greatcms === "focus" && typeof data.path === "string") {
        focus(data.path);
      } else if (data.greatcms === "reload" && !WATCHED) {
        location.reload();
      }
    });

    DOC.addEventListener("pointermove", onMove, true);
    DOC.addEventListener("click", onClick, true);
    DOC.addEventListener("keydown", onKey, true);
    DOC.addEventListener("pointerleave", hide);
    let frame = 0;
    const relayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        drawSections();
        if (hovered) show(hovered, tag.textContent, box.classList.contains("is-block"));
      });
    };
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", relayout, { passive: true });
    // The page changes under the studio's own edits; look again once it settles.
    let settle = 0;
    new MutationObserver((records) => {
      if (!fields.length) return;
      const ours = (node) => node === host || node === pointer;
      if (records.every((r) => ours(r.target) || [...r.addedNodes, ...r.removedNodes].every(ours))) return;
      window.clearTimeout(settle);
      settle = window.setTimeout(() => { index(); report(); }, 150);
    }).observe(DOC.documentElement, { childList: true, subtree: true, characterData: true });

    restore();
    // Astro's view transitions swap the head and the root's attributes, taking the crosshair with them.
    DOC.addEventListener("astro:after-swap", restore);

    const hello = () => window.parent.postMessage({ greatcms: "ready", reloads: WATCHED }, "*");
    if (DOC.readyState === "loading") DOC.addEventListener("DOMContentLoaded", hello, { once: true });
    else hello();
  })();
}
`;

/**
 * Live editing: the form's edits reach the dev server as a draft, and the framed page
 * talks back. The page's inspector (added by the reader's dev integration) finds where
 * each field renders; clicking there opens the field here, and focusing a field here
 * scrolls the page to it.
 */

const DEBOUNCE_MS = 400;

interface Field {
  path: string;
  dotted: string;
  label: string;
  kind: "text" | "richtext" | "image";
  value: string;
  block: { id: string; label: string } | null;
  /** Another editor holds this one: the page's header, say, while a page is being edited. */
  href?: string;
}

type Message =
  /** `reloads: false` is a page whose dev server does not watch content, so the studio asks it to. */
  | { greatcms: "ready"; reloads?: boolean }
  | { greatcms: "pick"; path?: string; block?: string }
  | { greatcms: "matched"; fields: number; of: number; blocks: number }
  | { greatcms: "mode"; select?: boolean; sections?: boolean };

const status = () => document.getElementById("live-status");
const remembered = (key: string) => localStorage.getItem(`greatcms:${key}`) === "1";
const say = (text: string) => status()?.replaceChildren(document.createTextNode(text));

function setUpDraft(form: HTMLFormElement, endpoint: string, saved: () => void): void {
  let timer: number | undefined;
  let inFlight = false;
  let queued = false;
  let stopped = false;
  const aborter = new AbortController();

  async function send(): Promise<void> {
    if (stopped) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;

    try {
      const body = new FormData(form);
      // An upload is not part of an unsaved draft: it has no committed path.
      // oxlint-disable-next-line no-useless-spread -- mutating while iterating
      for (const [key, value] of [...body.entries()]) {
        if (typeof value !== "string") body.delete(key);
      }

      const response = await fetch(endpoint, { method: "POST", body, signal: aborter.signal });
      if (!response.ok) throw new Error(`draft failed: ${response.status}`);
      say("Your site is showing this edit");
      saved();
    } catch (error) {
      if (stopped) return;
      say("Could not reach your dev server");
      console.error(error);
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void send();
      }
    }
  }

  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void send(), DEBOUNCE_MS);
  };

  form.addEventListener("input", schedule);
  form.addEventListener("change", schedule);

  // Leaving a field to press Publish or Discard fires `change`, which would
  // write the draft back after the server had just removed it.
  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    aborter.abort();
  };
  document.addEventListener("submit", stop, true);
  window.addEventListener("pagehide", stop);
}

/** `f[blocks][3][title]` → `blocks.3.title`, the form a site's own `data-greatcms-field` uses. */
const dotted = (name: string) =>
  [...name.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]).join(".");

const labelOf = (control: Element) => {
  const field = control.closest(".field");
  // The control's own label: a link field holds two, its address and its words.
  const label =
    (control.id ? field?.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null) ??
    field?.querySelector("label");
  const text = (label?.childNodes[0]?.textContent ?? label?.textContent ?? "").trim() || "Field";
  // A list's rows are labelled "Item 2"; the list's own name says more.
  const row = /^Item (\d+)$/.exec(text);
  const list = row
    ? field?.parentElement?.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
    : null;
  return list ? `${list} ${row![1]}` : text;
};

/** The outermost section a control sits in, or the region itself when the page has none. */
function blockOf(control: Element): Field["block"] {
  let block: HTMLElement | null = null;
  for (let node = control.parentElement; node; node = node.parentElement) {
    if (node.matches("section.block-collapsible")) block = node;
  }
  if (block) {
    return {
      id: block.id,
      label: block.querySelector("summary h2, summary h3")?.textContent?.trim() ?? "Section",
    };
  }
  return { id: "region", label: document.querySelector("h1")?.textContent?.trim() ?? "This" };
}

/** Everything in the form that renders as something a visitor could point at. */
function collect(form: HTMLFormElement): Field[] {
  const fields: Field[] = [];
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"][name^="f["], input[type="url"][name^="f["], textarea[name^="f["]',
  )) {
    const name = control.name;
    const value = control.value.trim();
    if (!value) continue;
    const isImage = name.endsWith("[src]");
    if (/\[(alt|width|height|_type)\]$/.test(name)) continue;
    fields.push({
      path: name,
      dotted: dotted(name),
      label: isImage
        ? labelOf(control.closest(".field")?.parentElement ?? control)
        : labelOf(control),
      kind: isImage ? "image" : control.hasAttribute("data-richtext") ? "richtext" : "text",
      value,
      block: blockOf(control),
    });
  }
  return fields;
}

/** Opens whatever folds a control away, then brings it on screen and into focus. */
function reveal(target: Element): void {
  for (let node = target.parentElement; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  const holder = target.closest(".field, .block-collapsible") ?? target;
  holder.classList.remove("is-picked");
  void (holder as HTMLElement).offsetWidth;
  holder.classList.add("is-picked");
  holder.scrollIntoView({ block: "center" });
  const focusable = target.closest(".field")?.querySelector<HTMLElement>(".ProseMirror");
  (focusable ?? (target as HTMLElement)).focus({ preventScroll: true });
}

/** Returns what to do once a draft is written: nothing, or ask a page that cannot reload itself to. */
function setUpInspector(form: HTMLFormElement, frame: HTMLIFrameElement): () => void {
  const frameOrigin = new URL(frame.src, location.href).origin;
  const post = (message: Record<string, unknown>) =>
    frame.contentWindow?.postMessage(message, frameOrigin);

  const select = document.querySelector<HTMLInputElement>("#live-select");
  const sections = document.querySelector<HTMLInputElement>("#live-sections");
  if (select) select.checked = remembered("select");
  if (sections) sections.checked = remembered("sections");
  for (const toggle of [select, sections])
    toggle?.closest(".live-toggle")?.removeAttribute("hidden");

  const mode = () => {
    const on = { select: Boolean(select?.checked), sections: Boolean(sections?.checked) };
    localStorage.setItem("greatcms:select", on.select ? "1" : "0");
    localStorage.setItem("greatcms:sections", on.sections ? "1" : "0");
    post({ greatcms: "mode", ...on });
  };
  select?.addEventListener("change", mode);
  sections?.addEventListener("change", mode);

  // The site's other regions, as the server listed them, so the footer is reachable from any page.
  let elsewhere: Field[] = [];
  try {
    elsewhere = JSON.parse(document.getElementById("live-elsewhere")?.textContent || "[]");
  } catch {
    elsewhere = [];
  }
  const sendFields = () => {
    post({ greatcms: "fields", fields: [...collect(form), ...elsewhere] });
    mode();
  };

  let reloadsItself = true;
  // A page that never says hello is a dev server that is not running, or one without the reader's
  // preview. A page's hello usually arrives before its load event, so a load only starts the clock
  // when that document has not spoken yet.
  let silent = 0;
  let heard = false;
  const listen = () => {
    window.clearTimeout(silent);
    if (heard) {
      heard = false;
      return;
    }
    silent = window.setTimeout(
      () => say("No answer from the page yet. Is its dev server running?"),
      5000,
    );
  };
  listen();
  frame.addEventListener("load", listen);
  window.addEventListener("message", (event: MessageEvent<Message>) => {
    if (event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.greatcms !== "string") return;

    if (data.greatcms === "ready") {
      window.clearTimeout(silent);
      heard = true;
      // The studio could not reach the dev server, but this browser can: the page is its own proof.
      frame.closest(".live-stage")?.classList.remove("is-down");
      document.querySelector(".live-down")?.remove();
      reloadsItself = data.reloads !== false;
      sendFields();
    } else if (data.greatcms === "matched") {
      const found = data.fields > 0 || data.blocks > 0;
      const where = select?.checked ? "Click anything on the page to edit it" : "";
      say(
        found
          ? `${count(data.blocks, "section")} and ${count(data.fields, "field")} on this page. ${where}`.trim()
          : "Nothing from this form is on the page you are looking at",
      );
    } else if (data.greatcms === "pick") {
      // Only something the form actually holds; the page is the user's own, but a path is still input.
      const target = data.path
        ? form.elements.namedItem(data.path)
        : data.block
          ? document.getElementById(data.block)
          : null;
      if (target instanceof Element) {
        reveal(target);
        return;
      }
      // Or something another editor holds: go there, and it opens at the field.
      const away = elsewhere.find((f) =>
        data.path ? f.path === data.path : f.block?.id === data.block,
      );
      if (away?.href?.startsWith("/sites/")) location.assign(away.href);
    } else if (data.greatcms === "mode" && select && typeof data.select === "boolean") {
      select.checked = data.select;
      mode();
    }
  });

  // Land in a field here and the page scrolls to where it shows.
  form.addEventListener("focusin", (event) => {
    // The control itself when it has a name (a link's label, not its address), else the field's first.
    const target = event.target as HTMLInputElement;
    const control = target.name?.startsWith("f[")
      ? target
      : target
          .closest(".field")
          ?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            'input[name^="f["], textarea[name^="f["]',
          );
    if (control?.name) post({ greatcms: "focus", path: control.name });
  });

  // Fields come back as the page reloads itself, so a draft only needs the page to ask again.
  frame.addEventListener("load", sendFields);
  return () => {
    if (!reloadsItself) post({ greatcms: "reload" });
  };
}

function start(): void {
  const frame = document.querySelector<HTMLIFrameElement>("iframe[data-live-site]");
  const endpoint = frame?.dataset.liveSite;
  const form = document.querySelector<HTMLFormElement>("form[data-editor-form]");
  if (!frame || !endpoint || !form) return;

  // A dev server without the watcher plugin gets the draft but never reloads
  // itself, so the button is offered wherever JavaScript can drive it.
  const reload = document.querySelector<HTMLButtonElement>("[data-live-reload]");
  if (reload) {
    reload.hidden = false;
    reload.addEventListener("click", () => {
      // Reassigning the same URL is what reloads a cross-origin frame; the
      // studio cannot reach into its document to do it any other way.
      const { src } = frame;
      frame.src = "about:blank";
      frame.src = src;
    });
  }

  setUpDraft(form, endpoint, setUpInspector(form, frame));

  // Arriving from another editor's preview: open at the field that was clicked there.
  const wanted = location.hash.slice(1);
  const landing = wanted ? document.getElementById(wanted) : null;
  if (landing && form.contains(landing)) reveal(landing);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Live editing. */

const DEBOUNCE_MS = 400;

function setUp(form: HTMLFormElement, endpoint: string): void {
  let timer: number | undefined;
  let inFlight = false;
  let queued = false;

  const status = document.getElementById("live-status");
  const say = (text: string) => status?.replaceChildren(document.createTextNode(text));

  async function send(): Promise<void> {
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

      const response = await fetch(endpoint, { method: "POST", body });
      if (!response.ok) throw new Error(`draft failed: ${response.status}`);
      say("Your site is showing this edit");
    } catch (error) {
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

  setUp(form, endpoint);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

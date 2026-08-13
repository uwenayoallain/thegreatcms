/**
 * Live preview.
 *
 * Posts whatever is currently in the form to the studio and swaps the result
 * into an iframe, so you see the content you are editing before anything is
 * committed. Debounced, and never more than one request in flight — typing
 * should not queue up a dozen renders.
 *
 * Without JavaScript the same endpoint is reachable through a submit button, so
 * preview degrades to a page load rather than disappearing.
 */

const DEBOUNCE_MS = 350;

function setUp(form: HTMLFormElement, frame: HTMLIFrameElement, endpoint: string): void {
  let timer: number | undefined;
  let inFlight = false;
  let queued = false;

  const status = document.getElementById("preview-status");

  async function render(): Promise<void> {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    status?.replaceChildren(document.createTextNode("Updating…"));

    try {
      const body = new FormData(form);
      // Uploads are not previewable until they are read server-side, and
      // sending them on every keystroke would be wasteful. The snapshot is
      // deliberate: deleting from a FormData while iterating it live skips
      // entries.
      // oxlint-disable-next-line no-useless-spread -- mutating while iterating
      for (const [key, value] of [...body.entries()]) {
        if (typeof value !== "string") body.delete(key);
      }

      const response = await fetch(endpoint, { method: "POST", body });
      if (!response.ok) throw new Error(`preview failed: ${response.status}`);
      frame.srcdoc = await response.text();
      status?.replaceChildren(document.createTextNode("Up to date"));
    } catch (error) {
      status?.replaceChildren(document.createTextNode("Preview unavailable"));
      console.error(error);
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void render();
      }
    }
  }

  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void render(), DEBOUNCE_MS);
  };

  form.addEventListener("input", schedule);
  form.addEventListener("change", schedule);
  void render();
}

function start(): void {
  const frame = document.querySelector<HTMLIFrameElement>("iframe[data-live-preview]");
  const endpoint = frame?.dataset.livePreview;
  const form = document.querySelector<HTMLFormElement>("form[data-editor-form]");
  if (!frame || !endpoint || !form) return;

  // The manual button is the no-JavaScript path; with JavaScript the preview
  // keeps itself current, so the button would only be confusing.
  document.querySelector("[data-preview-fallback]")?.remove();

  setUp(form, frame, endpoint);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

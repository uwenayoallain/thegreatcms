/**
 * The two things an editor drags: the line between the sidebar and the page, and the line
 * between the form and the preview. Each remembers its place; without this script the
 * handles stay hidden and the stylesheet's defaults apply.
 */

interface Resizer {
  handle: HTMLElement;
  /** The element whose custom property the width lands on. */
  target: HTMLElement;
  property: string;
  key: string;
  min: number;
  max: () => number;
  /** Where the width is measured from: the left edge of the target, or its right edge. */
  from: "left" | "right";
}

const STEP = 16;

function setUp({ handle, target, property, key, min, max, from }: Resizer): void {
  // What the stylesheet gave it, until a drag or a key says otherwise.
  const measure = () => {
    const value = getComputedStyle(target).getPropertyValue(property).trim();
    return Number.parseFloat(value) || min;
  };
  const apply = (width: number) => {
    const clamped = Math.round(Math.min(Math.max(width, min), max()));
    target.style.setProperty(property, `${clamped}px`);
    handle.setAttribute("aria-valuenow", String(clamped));
    return clamped;
  };
  const remember = (width: number) => localStorage.setItem(`greatcms:${key}`, String(width));

  const stored = Number(localStorage.getItem(`greatcms:${key}`));
  if (stored > 0) apply(stored);
  else handle.setAttribute("aria-valuenow", String(Math.round(measure())));
  handle.hidden = false;

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");
    const rect = target.getBoundingClientRect();
    let width = 0;
    const move = (e: PointerEvent) => {
      width = apply(from === "left" ? e.clientX - rect.left : rect.right - e.clientX);
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      document.body.classList.remove("is-resizing");
      if (width) remember(width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });

  handle.addEventListener("keydown", (event) => {
    const current = Number(handle.getAttribute("aria-valuenow")) || measure();
    const grow = from === "left" ? event.key === "ArrowRight" : event.key === "ArrowLeft";
    const shrink = from === "left" ? event.key === "ArrowLeft" : event.key === "ArrowRight";
    if (!grow && !shrink) return;
    event.preventDefault();
    remember(apply(current + (grow ? STEP : -STEP)));
  });
}

/** The desktop preview scales a 1280px page to the pane, never larger than life. */
function scalePreview(): void {
  const stage = document.querySelector<HTMLElement>(".live-stage");
  const live = stage?.closest<HTMLElement>(".live");
  if (!stage || !live) return;
  const fit = () => {
    const zoom = Math.min(1, stage.getBoundingClientRect().width / 1280);
    live.style.setProperty("--live-zoom", zoom.toFixed(3));
  };
  new ResizeObserver(fit).observe(stage);
  fit();
}

function start(): void {
  scalePreview();
  const sidebar = document.querySelector<HTMLElement>("[data-resize-sidebar]");
  if (sidebar) {
    setUp({
      handle: sidebar,
      target: document.body,
      property: "--sidebar-width",
      key: "sidebar-width",
      min: 176,
      max: () => Math.min(480, window.innerWidth * 0.4),
      from: "left",
    });
  }
  const split = document.querySelector<HTMLElement>(".split");
  const live = document.querySelector<HTMLElement>("[data-resize-live]");
  if (split && live) {
    setUp({
      handle: live,
      target: split,
      property: "--live-width",
      key: "live-width",
      min: 320,
      max: () => split.getBoundingClientRect().width - 360,
      from: "right",
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

/**
 * What CSS cannot know: where the pointer is. A cursor that names what it is over, buttons that
 * lean toward it, covers that tilt under it, and a hero that follows it. Where the browser cannot
 * tie animation to scroll, Motion stands in for the stylesheet. With reduced motion, none of it runs.
 */

import { inView, scroll } from "motion";
import { animate } from "motion/mini";

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(pointer: fine)").matches;
const scrollTimelines = CSS.supports("animation-timeline: view()");
const all = <T extends Element = HTMLElement>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

if (!reduced) {
  follow();
  if (finePointer) {
    cursor();
    magnetic();
    tilt();
  }
  if (!scrollTimelines) standIn();
}

/** The hero's colour drifts after the pointer; the stylesheet reads --mx and --my. */
function follow(): void {
  const hero = document.querySelector<HTMLElement>(".hero");
  if (!hero) return;
  addEventListener(
    "pointermove",
    (event) => {
      hero.style.setProperty("--mx", `${(event.clientX / innerWidth) * 100}%`);
      hero.style.setProperty("--my", `${(event.clientY / innerHeight) * 100}%`);
    },
    { passive: true },
  );
}

/** A dot that trails the pointer and grows into a label over anything marked data-cursor. */
function cursor(): void {
  const dot = document.querySelector<HTMLElement>(".cursor");
  const label = dot?.querySelector<HTMLElement>(".cursor__label");
  if (!dot || !label) return;
  document.documentElement.classList.add("has-cursor");
  let x = innerWidth / 2;
  let y = innerHeight / 2;
  let drawnX = x;
  let drawnY = y;
  addEventListener(
    "pointermove",
    (event) => {
      x = event.clientX;
      y = event.clientY;
      const target = (event.target as Element | null)?.closest?.("[data-cursor]");
      dot.classList.toggle("is-label", Boolean(target));
      if (target) label.textContent = target.getAttribute("data-cursor");
      dot.style.opacity = "1";
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => (dot.style.opacity = "0"));
  const draw = () => {
    drawnX += (x - drawnX) * 0.22;
    drawnY += (y - drawnY) * 0.22;
    dot.style.transform = `translate3d(${drawnX}px, ${drawnY}px, 0)`;
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

/** Buttons lean a quarter of the way toward the pointer; the stylesheet eases them back. */
function magnetic(): void {
  for (const element of all("[data-magnetic]")) {
    element.addEventListener("pointermove", (event) => {
      const box = element.getBoundingClientRect();
      element.style.setProperty(
        "--pull-x",
        `${(event.clientX - box.left - box.width / 2) * 0.25}px`,
      );
      element.style.setProperty(
        "--pull-y",
        `${(event.clientY - box.top - box.height / 2) * 0.3}px`,
      );
    });
    element.addEventListener("pointerleave", () => {
      element.style.setProperty("--pull-x", "0px");
      element.style.setProperty("--pull-y", "0px");
    });
  }
}

/** Project covers tilt a few degrees under the pointer, with a light where it rests. */
function tilt(): void {
  for (const card of all(".work-card")) {
    const media = card.querySelector<HTMLElement>(".work-card__media");
    if (!media) continue;
    card.addEventListener("pointermove", (event) => {
      const box = media.getBoundingClientRect();
      const px = clamp((event.clientX - box.left) / box.width);
      const py = clamp((event.clientY - box.top) / box.height);
      media.style.setProperty("--mx", `${px * 100}%`);
      media.style.setProperty("--my", `${py * 100}%`);
      media.style.setProperty("--tilt-y", `${(px - 0.5) * 7}deg`);
      media.style.setProperty("--tilt-x", `${(0.5 - py) * 7}deg`);
    });
    card.addEventListener("pointerleave", () => {
      media.style.setProperty("--tilt-x", "0deg");
      media.style.setProperty("--tilt-y", "0deg");
    });
  }
}

/** The scroll-driven half of the stylesheet, done by hand for browsers without scroll timelines. */
function standIn(): void {
  document.documentElement.classList.add("scroll-fallback");

  const bar = document.querySelector<HTMLElement>(".progress");
  if (bar) scroll((progress: number) => (bar.style.transform = `scaleX(${progress})`));

  for (const element of all(
    ".reveal-title, .work-card, .quote p, .cta, .service, .prose > *, .case__results > div",
  )) {
    element.style.opacity = "0";
    inView(
      element,
      () => {
        animate(
          element,
          { opacity: [0, 1], transform: ["translateY(3rem)", "none"] },
          { duration: 1, ease: EASE },
        );
      },
      { margin: "0px 0px -15% 0px" },
    );
  }

  for (const count of all(".count")) {
    const value = count.querySelector<HTMLElement>(".count__value");
    const to = Number(count.dataset.count);
    const pad = Number(count.dataset.pad);
    if (!value || !Number.isFinite(to)) continue;
    inView(count, () => {
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min((now - start) / 1600, 1);
        value.textContent = String(Math.round(to * (1 - (1 - t) ** 4))).padStart(pad, "0");
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  for (const statement of all(".statement")) {
    const words = all<HTMLElement>(".statement__word").filter((word) => statement.contains(word));
    statement.classList.add("is-pinned");
    scroll(
      (progress: number) => {
        words.forEach((word, i) => {
          word.style.opacity = String(0.14 + 0.86 * clamp(progress * 1.25 * words.length - i));
        });
      },
      { target: statement, offset: ["start start", "end end"] },
    );
  }

  for (const process of all(".process")) {
    const row = process.querySelector<HTMLElement>(".process__row");
    const fill = process.querySelector<HTMLElement>(".process__bar span");
    if (!row) continue;
    process.classList.add("is-pinned");
    scroll(
      (progress: number) => {
        const travel = row.scrollWidth - process.clientWidth;
        row.style.transform = `translateX(${-travel * progress}px)`;
        if (fill) fill.style.transform = `scaleX(${progress})`;
      },
      { target: process, offset: ["start start", "end end"] },
    );
  }
}

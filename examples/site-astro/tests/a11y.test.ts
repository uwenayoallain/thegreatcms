/**
 * Accessibility gate.
 *
 * Runs axe against the *built* HTML, so it checks what actually ships rather
 * than what a component looked like in isolation. This runs in CI and failing
 * it fails the build — accessibility is a gate here, not a checklist.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const DIST = join(new URL("..", import.meta.url).pathname, "dist");

const PAGES = [
  { name: "home", file: "index.html" },
  { name: "about", file: "about/index.html" },
  { name: "blog index", file: "blog/index.html" },
  { name: "blog post", file: "blog/publish-from-anywhere/index.html" },
  { name: "thanks", file: "thanks/index.html" },
];

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/site-astro before the a11y tests.");
  }
});

describe.each(PAGES)("$name", ({ file }) => {
  it("has no axe violations", async () => {
    const html = readFileSync(join(DIST, file), "utf8");
    const dom = new JSDOM(html, { pretendToBeVisual: true, url: "https://example.com/" });

    // axe needs the page's globals; jsdom provides them per-instance.
    const { window } = dom;
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).document = window.document;
    (globalThis as Record<string, unknown>).Node = window.Node;

    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      // Colour contrast needs real layout, which jsdom does not do. It is
      // covered by the palette being checked by hand and by the Playwright
      // pass; asserting it here would only produce false confidence.
      rules: { "color-contrast": { enabled: false } },
    });

    const summary = results.violations.map(
      (v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`,
    );
    expect(summary).toEqual([]);
  });

  it("ships no JavaScript", () => {
    const html = readFileSync(join(DIST, file), "utf8");
    expect(html).not.toMatch(/<script/i);
  });

  it("has a language, a title, one h1, and a skip link", () => {
    const html = readFileSync(join(DIST, file), "utf8");
    const { document } = new JSDOM(html).window;

    expect(document.documentElement.lang).toBe("en");
    expect(document.title.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("a.skip-link")?.getAttribute("href")).toBe("#main");
    expect(document.querySelector("main")?.id).toBe("main");
  });
});

describe("the contact form", () => {
  it("labels every control and can be submitted without JavaScript", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    const { document } = new JSDOM(html).window;

    const form = document.querySelector("form.contact");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form?.getAttribute("action")).toBeTruthy();

    for (const control of form?.querySelectorAll("input:not([type=hidden]), textarea") ?? []) {
      const id = control.getAttribute("id");
      expect(id, "every control needs an id to be labelled").toBeTruthy();
      expect(
        document.querySelector(`label[for="${id}"]`),
        `control #${id} has no <label for>`,
      ).toBeTruthy();
    }

    // The honeypot must be hidden from assistive tech, not just from sight.
    const trap = document.querySelector(".trap");
    expect(trap?.getAttribute("aria-hidden")).toBe("true");
    expect(trap?.querySelector("input")?.getAttribute("tabindex")).toBe("-1");
  });
});

/**
 * Performance budget.
 *
 * "Resource efficient" decays silently unless something fails when it stops
 * being true. These numbers are generous against today's output (~50 KB total)
 * and exist to catch a regression — a font, an analytics snippet, a framework
 * island — not to police every byte.
 */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const kilobytes = (files: string[]) =>
  files.reduce((total, file) => total + statSync(file).size, 0) / 1024;

describe("weight", () => {
  const BUDGETS = {
    totalKb: 120,
    htmlKb: 20,
    cssKb: 20,
  };

  it("keeps the whole site under budget", () => {
    const total = kilobytes(walk(DIST));
    expect(total, `${total.toFixed(1)} KB total`).toBeLessThan(BUDGETS.totalKb);
  });

  it("keeps each page's HTML small", () => {
    for (const page of PAGES) {
      const size = statSync(join(DIST, page.file)).size / 1024;
      expect(size, `${page.name} is ${size.toFixed(1)} KB`).toBeLessThan(BUDGETS.htmlKb);
    }
  });

  it("ships one small stylesheet, and no JavaScript at all", () => {
    const files = walk(DIST);
    const css = files.filter((file) => file.endsWith(".css"));
    const js = files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));

    expect(js).toEqual([]);
    expect(kilobytes(css)).toBeLessThan(BUDGETS.cssKb);
  });
});

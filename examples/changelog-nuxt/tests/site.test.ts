/** The built changelog: accessible, free of JavaScript, and showing what the content files say. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const read = (file: string) => readFileSync(join(DIST, file), "utf8");
const dom = (file: string) => new JSDOM(read(file)).window.document;
const RELEASES = readdirSync(join(ROOT, "content/changelog"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.replace(/\.md$/, ""));

const PAGES = [
  { name: "home", file: "index.html" },
  { name: "changelog", file: "changelog/index.html" },
  { name: "thanks", file: "thanks/index.html" },
  { name: "not found", file: "404.html" },
  ...RELEASES.map((slug) => ({ name: `release ${slug}`, file: `changelog/${slug}/index.html` })),
];

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/changelog-nuxt before its tests.");
  }
});

describe.each(PAGES)("$name", ({ file }) => {
  it("has no axe violations", async () => {
    const { window } = new JSDOM(read(file), {
      pretendToBeVisual: true,
      url: "https://sundial.example/",
    });
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).document = window.document;
    (globalThis as Record<string, unknown>).Node = window.Node;
    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("ships no executable JavaScript, not even Nuxt's runtime, and none of the studio's preview", () => {
    const html = read(file);
    expect(html).not.toMatch(/modulepreload/i);
    expect(html).not.toContain("data-greatcms");
    expect(html).not.toContain("greatcms:");
    const scripts = [...dom(file).querySelectorAll("script")].filter(
      (s) => s.getAttribute("type") !== "speculationrules",
    );
    expect(scripts).toHaveLength(0);
  });

  it("has a language, a title, one h1 and a skip link", () => {
    const document = dom(file);
    expect(document.documentElement.lang).toBe("en");
    expect(document.title.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("a.skip-link")?.getAttribute("href")).toBe("#main");
  });
});

describe("the changelog", () => {
  it("lists every release on the changelog page, newest first", () => {
    const page = dom("changelog/index.html");
    const links = [...page.querySelectorAll('ol.log a[href^="/changelog/"]')].map((a) =>
      a.getAttribute("href"),
    );
    expect(new Set(links)).toEqual(new Set(RELEASES.map((slug) => `/changelog/${slug}/`)));
    const dates = [...page.querySelectorAll("ol.log time")].map((t) => t.getAttribute("datetime"));
    expect(dates).toEqual(dates.toSorted().toReversed());
  });

  it("renders each release's Markdown body as HTML", () => {
    for (const slug of RELEASES) {
      const prose = dom(`changelog/${slug}/index.html`).querySelector(".prose");
      expect(prose?.querySelectorAll("p").length, slug).toBeGreaterThan(0);
      expect(prose?.textContent, slug).not.toContain("## ");
    }
  });
});

describe("the waitlist form", () => {
  it("posts to the studio's inbox with a labelled email field", () => {
    const document = dom("index.html");
    const form = document.querySelector("form");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(form?.getAttribute("action")).toMatch(/\/f\/[\w-]+\/waitlist$/);
    const email = form?.querySelector('input[type="email"]');
    expect(document.querySelector(`label[for="${email?.id}"]`)).toBeTruthy();
  });
});

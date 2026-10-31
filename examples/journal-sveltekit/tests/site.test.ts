/** The built journal: script-free, accessible, and every essay in the collection on the page. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const read = (file: string) => readFileSync(join(DIST, file), "utf8");
const dom = (file: string) => new JSDOM(read(file)).window.document;
const ESSAYS = readdirSync(join(ROOT, "content/essays"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.replace(/\.md$/, ""));

const PAGES = [
  { name: "home", file: "index.html" },
  { name: "about", file: "about/index.html" },
  { name: "subscribed", file: "subscribed/index.html" },
  { name: "not found", file: "404.html" },
  ...ESSAYS.map((slug) => ({ name: `essay ${slug}`, file: `essays/${slug}/index.html` })),
];

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/journal-sveltekit before its tests.");
  }
});

describe.each(PAGES)("$name", ({ file }) => {
  it("has no axe violations", async () => {
    const { window } = new JSDOM(read(file), {
      pretendToBeVisual: true,
      url: "https://longlight.example/",
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

  it("ships no JavaScript, not even SvelteKit's runtime, and none of the studio's preview", () => {
    expect(read(file)).not.toMatch(/<script|modulepreload/i);
    expect(read(file)).not.toContain("data-greatcms");
  });

  it("has a language, a title and one h1", () => {
    const document = dom(file);
    expect(document.documentElement.lang).toBe("en");
    expect(document.title.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });
});

describe("the essays", () => {
  it("lists every essay on the home page, newest first", () => {
    const links = [...dom("index.html").querySelectorAll('main a[href^="/essays/"]')].map((a) =>
      a.getAttribute("href"),
    );
    expect(new Set(links)).toEqual(new Set(ESSAYS.map((slug) => `/essays/${slug}/`)));
    const dates = [...dom("index.html").querySelectorAll("main time")].map((t) =>
      t.getAttribute("datetime"),
    );
    expect(dates).toEqual(dates.toSorted().toReversed());
  });

  it("renders each essay's Markdown body as HTML", () => {
    for (const slug of ESSAYS) {
      const prose = dom(`essays/${slug}/index.html`).querySelector(".prose");
      expect(prose?.querySelectorAll("p").length, slug).toBeGreaterThan(1);
      expect(prose?.textContent, slug).not.toContain("## ");
    }
  });
});

describe("the newsletter form", () => {
  it("posts to the studio's inbox with a labelled email field", () => {
    const document = dom("index.html");
    const form = document.querySelector("form");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(form?.getAttribute("action")).toMatch(/\/f\/[\w-]+\/newsletter$/);
    const email = form?.querySelector('input[type="email"]');
    expect(document.querySelector(`label[for="${email?.id}"]`)).toBeTruthy();
  });
});

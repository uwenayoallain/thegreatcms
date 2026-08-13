/**
 * The docs site holds itself to the same bars as everything else: no
 * JavaScript, no axe violations, and a weight budget. It is also the project's
 * dogfood — its landing copy is managed by the CMS it documents — so these
 * tests double as proof that a real site can be built this way.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const DIST = join(new URL("..", import.meta.url).pathname, "dist");

const PAGES = [
  { name: "landing", file: "index.html" },
  { name: "docs index", file: "docs/index.html" },
  { name: "a docs page", file: "docs/getting-started/index.html" },
  { name: "the standard", file: "spec/index.html" },
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const kilobytes = (files: string[]) =>
  files.reduce((total, file) => total + statSync(file).size, 0) / 1024;

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in apps/docs before these tests.");
  }
});

describe.each(PAGES)("$name", ({ file }) => {
  it("has no axe violations", async () => {
    const html = readFileSync(join(DIST, file), "utf8");
    const dom = new JSDOM(html, { pretendToBeVisual: true, url: "https://greatcms.dev/" });
    const { window } = dom;
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });

    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      // jsdom has no layout, so contrast cannot be measured here.
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("ships no JavaScript", () => {
    expect(readFileSync(join(DIST, file), "utf8")).not.toMatch(/<script/i);
  });

  it("has a language, a title, one h1, and a skip link", () => {
    const { document } = new JSDOM(readFileSync(join(DIST, file), "utf8")).window;
    expect(document.documentElement.lang).toBe("en");
    expect(document.title.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("a.skip-link")?.getAttribute("href")).toBe("#main");
  });
});

describe("the landing page", () => {
  it("renders content the CMS manages", () => {
    const { document } = new JSDOM(readFileSync(join(DIST, "index.html"), "utf8")).window;

    // Straight from content/cms/home.hero.json and home.claims.json.
    expect(document.querySelector("h1")?.textContent).toContain(
      "A CMS your site does not depend on",
    );
    expect(document.querySelectorAll(".claims li").length).toBeGreaterThanOrEqual(4);
    expect(document.body.textContent).toContain("Nothing at runtime");
  });

  it("says plainly that it is managed by the thing it describes", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    expect(html).toContain("managed by the thing it describes");
  });
});

describe("the docs", () => {
  it("builds a page per collection entry, in schema order", () => {
    const { document } = new JSDOM(readFileSync(join(DIST, "docs/index.html"), "utf8")).window;
    const titles = [...document.querySelectorAll(".index-list h2")].map((h) =>
      h.textContent?.trim(),
    );

    expect(titles[0]).toBe("Getting started");
    expect(titles).toContain("Accessibility");
    expect(titles.length).toBeGreaterThanOrEqual(6);
  });

  it("renders the standard from SPEC.md, so the two cannot drift", () => {
    const html = readFileSync(join(DIST, "spec/index.html"), "utf8");
    expect(html).toContain("Resolution rules");
    expect(html).toContain("decorative-allowed");
  });

  it("serves the agent entrypoints", () => {
    for (const file of ["llms.txt", "llms-full.txt", "docs.json"]) {
      expect(existsSync(join(DIST, file)), file).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(DIST, "docs.json"), "utf8"));
    expect(manifest.agentEntrypoints.llmsFull).toBe("/llms-full.txt");
  });
});

describe("weight", () => {
  it("keeps the whole site well under budget", () => {
    // Includes the agent text files, which are documentation rather than page weight.
    const total = kilobytes(walk(DIST));
    expect(total, `${total.toFixed(1)} KB total`).toBeLessThan(220);
  });

  it("keeps every page's HTML small", () => {
    for (const page of PAGES) {
      const size = statSync(join(DIST, page.file)).size / 1024;
      expect(size, `${page.name} is ${size.toFixed(1)} KB`).toBeLessThan(45);
    }
  });

  it("ships one small stylesheet and no scripts", () => {
    const files = walk(DIST);
    expect(files.filter((file) => file.endsWith(".js"))).toEqual([]);
    expect(kilobytes(files.filter((file) => file.endsWith(".css")))).toBeLessThan(20);
  });
});

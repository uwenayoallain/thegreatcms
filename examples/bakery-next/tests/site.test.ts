/** The exported bakery: accessible, free of the studio, and showing what the content files say. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const read = (file: string) => readFileSync(join(DIST, file), "utf8");
const dom = (file: string) => new JSDOM(read(file)).window.document;

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const PAGES = [
  { name: "home", file: "index.html" },
  { name: "menu", file: "menu/index.html" },
  { name: "thanks", file: "thanks/index.html" },
  { name: "not found", file: "404.html" },
];

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/bakery-next before its tests.");
  }
});

describe.each(PAGES)("$name", ({ file }) => {
  it("has no axe violations", async () => {
    const { window } = new JSDOM(read(file), {
      pretendToBeVisual: true,
      url: "https://hearth.example/",
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

  it("carries nothing of the studio: its preview runs under `next dev` only", () => {
    expect(read(file)).not.toContain("data-greatcms");
    expect(read(file)).not.toContain("greatcms:");
  });

  it("has a language, a title, one h1 and a skip link", () => {
    const document = dom(file);
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toMatch(/Hearth/);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("a.skip-link")?.getAttribute("href")).toBe("#main");
  });

  it("is complete as HTML, so it reads before any script runs", () => {
    const document = dom(file);
    expect(document.querySelector("main")?.textContent?.trim().length).toBeGreaterThan(20);
    expect(document.querySelector("footer address")).not.toBeNull();
  });
});

describe.each(PAGES)("$name, for search and sharing", ({ file }) => {
  it("has a description, a share card with an image, and an address of its own where it should be found", () => {
    const document = dom(file);
    const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content");
    expect(meta('meta[name="description"]')?.length).toBeGreaterThan(0);
    expect(meta('meta[property="og:title"]')).toBe(document.title);
    expect(meta('meta[property="og:image"]')).toBe("https://hearth.example/og.png");
    expect(meta('meta[name="twitter:card"]')).toBe("summary_large_image");
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    // A page with no address worth indexing says so instead of naming one.
    if (meta('meta[name="robots"]') === "noindex") expect(canonical).toBeUndefined();
    else expect(canonical).toBe(`https://hearth.example/${file.replace(/index\.html$/, "")}`);
  });

  it("links only to pages that were built", () => {
    for (const link of dom(file).querySelectorAll('a[href^="/"]')) {
      const path = link.getAttribute("href")!.split("#")[0]!;
      expect(existsSync(join(DIST, path, "index.html")), `${file}: ${path}`).toBe(true);
    }
  });
});

describe("for search engines", () => {
  it("lists the pages worth finding in the sitemap, points robots.txt at it, and publishes the share image", () => {
    const listed = [
      ...read("sitemap.xml").matchAll(/<loc>https:\/\/hearth\.example([^<]*)<\/loc>/g),
    ];
    expect(listed.map((match) => match[1]).toSorted()).toEqual(["/", "/menu/"]);
    expect(read("robots.txt")).toContain("Sitemap: https://hearth.example/sitemap.xml");
    expect(existsSync(join(DIST, "og.png"))).toBe(true);
  });

  it("describes the bakery, with its opening hours, as structured data on the home page", () => {
    const data = JSON.parse(
      dom("index.html").querySelector('script[type="application/ld+json"]')!.textContent!,
    ) as { "@type": string; openingHours: string[] };
    expect(data["@type"]).toBe("Bakery");
    expect(data.openingHours.length).toBeGreaterThan(0);
  });
});

describe("the bundle", () => {
  const assets = files(join(DIST, "_next"));

  it("has no client component of its own: the only scripts are the ones Next.js brings", () => {
    const sources = files(join(ROOT, "app")).filter((path) => /\.tsx?$/.test(path));
    for (const path of sources)
      expect(readFileSync(path, "utf8"), path).not.toMatch(/^"use client"/m);
  });

  it("has one minified stylesheet", () => {
    const css = assets.filter((path) => path.endsWith(".css"));
    expect(css).toHaveLength(1);
    expect(readFileSync(css[0] as string, "utf8")).not.toMatch(/\n\s/);
  });

  it("keeps the JavaScript Next.js brings under a budget", () => {
    const bytes = assets
      .filter((path) => path.endsWith(".js"))
      .reduce((total, path) => total + statSync(path).size, 0);
    // React and the router, before compression. The pages themselves are HTML.
    expect(bytes).toBeLessThan(700_000);
  });
});

describe("the menu", () => {
  const entries = readdirSync(join(ROOT, "content/menu")).filter((file) => file.endsWith(".json"));

  it("lists every item in the collection, each with a price", () => {
    const items = dom("menu/index.html").querySelectorAll(".item");
    expect(items).toHaveLength(entries.length);
    for (const item of items) expect(item.querySelector(".price")?.textContent).toMatch(/^RWF \d/);
  });

  it("groups items in the order the schema lists the categories", () => {
    const headings = [...dom("menu/index.html").querySelectorAll(".menu-section h2")];
    expect(headings.map((h) => h.textContent)).toEqual(["Bread", "Pastry", "Coffee & tea"]);
  });

  it("puts only featured items on the home page", () => {
    const featured = entries.filter(
      (file) => JSON.parse(readFileSync(join(ROOT, "content/menu", file), "utf8")).featured,
    );
    expect(dom("index.html").querySelectorAll(".featured .card")).toHaveLength(featured.length);
  });
});

describe("the order form", () => {
  it("posts to the studio's inbox and labels every control", () => {
    const document = dom("index.html");
    const form = document.querySelector("form.form");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(form?.getAttribute("action")).toMatch(/\/f\/[\w-]+\/order$/);

    for (const control of form?.querySelectorAll("input:not([type=hidden]), textarea") ?? []) {
      const labelled =
        control.closest("label") ?? document.querySelector(`label[for="${control.id}"]`);
      expect(labelled, `${control.getAttribute("name")} has no label`).toBeTruthy();
    }
  });

  it("sends every ticked item under one name, as a checkbox group", () => {
    const boxes = dom("index.html").querySelectorAll('form input[type="checkbox"]');
    expect(boxes.length).toBeGreaterThan(1);
    expect(new Set([...boxes].map((box) => box.getAttribute("name")))).toEqual(new Set(["items"]));
  });
});

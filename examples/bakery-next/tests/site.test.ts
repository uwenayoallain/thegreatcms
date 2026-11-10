/** The exported bakery: accessible, free of the studio and of scripts, and showing what the content files say. */

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

  it("links only to pages, and places on them, that were built", () => {
    for (const link of dom(file).querySelectorAll('a[href^="/"]')) {
      const [path, fragment] = link.getAttribute("href")!.split("#") as [string, string?];
      const target = path.endsWith(".html") ? path : join(path, "index.html");
      expect(existsSync(join(DIST, target)), `${file}: ${path}`).toBe(true);
      if (fragment)
        expect(dom(target).getElementById(fragment), `${file}: ${path}#${fragment}`).not.toBeNull();
    }
  });

  it("asks only for files that were built", () => {
    for (const element of dom(file).querySelectorAll("link[href^='/'], [src^='/']")) {
      const url = (element.getAttribute("href") ?? element.getAttribute("src"))!.split(/[?#]/)[0]!;
      const target = url.endsWith("/") ? join(url, "index.html") : url;
      expect(existsSync(join(DIST, target)), `${file}: ${url}`).toBe(true);
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

describe("the export", () => {
  const all = files(DIST);
  const html = all.filter((path) => path.endsWith(".html"));
  const css = all.filter((path) => path.endsWith(".css"));

  it("has no client component of its own, which is what lets the build drop the runtime", () => {
    const sources = files(join(ROOT, "app")).filter((path) => /\.tsx?$/.test(path));
    for (const path of sources)
      expect(readFileSync(path, "utf8"), path).not.toMatch(/^"use client"/m);
  });

  it("has no executable script on any page: none inline, none loaded, none preloaded, no handler", () => {
    expect(html.length).toBeGreaterThanOrEqual(PAGES.length);
    for (const path of html) {
      const document = new JSDOM(readFileSync(path, "utf8")).window.document;
      const scripts = [...document.querySelectorAll("script")].map((script) => script.type);
      expect(
        scripts.filter((type) => type !== "application/ld+json"),
        path,
      ).toEqual([]);
      expect(
        document.querySelectorAll('link[rel="modulepreload"], link[as="script"]'),
        path,
      ).toHaveLength(0);
      for (const element of document.querySelectorAll("*"))
        for (const { name, value } of element.attributes) {
          expect(name, `${path}: <${element.localName} ${name}>`).not.toMatch(/^on/);
          expect(value, `${path}: <${element.localName} ${name}>`).not.toMatch(/^\s*javascript:/i);
        }
    }
  });

  it("ships no JavaScript file, and none of the data only a client router would fetch", () => {
    const names = all.map((path) => path.slice(DIST.length));
    expect(names.filter((name) => /\.m?js$/.test(name))).toEqual([]);
    expect(names.filter((name) => name.endsWith(".txt"))).toEqual(["/robots.txt"]);
  });

  it("has one minified stylesheet, and every file it names was built", () => {
    expect(css).toHaveLength(1);
    const sheet = readFileSync(css[0] as string, "utf8");
    expect(sheet).not.toMatch(/\n\s/);
    for (const [, url] of sheet.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      if (url!.startsWith("data:")) continue;
      const target = url!.startsWith("/") ? join(DIST, url!) : join(css[0] as string, "..", url!);
      expect(existsSync(target), url).toBe(true);
    }
  });

  it("keeps its motion in the stylesheet: page transitions and scroll-driven effects need no script", () => {
    const sheet = readFileSync(css[0] as string, "utf8");
    expect(sheet).toMatch(/@view-transition\s*\{\s*navigation:\s*auto/);
    expect(sheet).toContain("view-transition-name:masthead");
    expect(sheet).toMatch(/animation-timeline:\s*view\(\)/);
    expect(sheet).toMatch(/animation-timeline:\s*scroll\(root\)/);
    expect(sheet).toMatch(/animation-range:\s*entry 10% entry 80%/);
    // What those rules move is on the pages.
    expect(dom("index.html").querySelector(".stamp text")).not.toBeNull();
    expect(dom("index.html").querySelector(".card")).not.toBeNull();
    expect(dom("menu/index.html").querySelector(".item")).not.toBeNull();
  });

  it.each(PAGES)("keeps $name, with everything it loads, under 50 KB", ({ file }) => {
    const document = dom(file);
    const loaded = new Set([join(DIST, file)]);
    for (const link of document.querySelectorAll("link[rel=stylesheet], link[rel=preload]"))
      loaded.add(join(DIST, link.getAttribute("href")!.split("?")[0]!));
    for (const element of document.querySelectorAll("[src]"))
      loaded.add(join(DIST, element.getAttribute("src")!.split("?")[0]!));
    const bytes = [...loaded].reduce((total, path) => total + statSync(path).size, 0);
    // Before compression: the page, its stylesheet and one font. The home page measures 44 KB.
    expect(bytes).toBeLessThan(50_000);
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

  it("leaves checking to the browser: required fields, typed inputs, and nothing switching that off", () => {
    const form = dom("index.html").querySelector("form.form")!;
    expect(form.hasAttribute("novalidate")).toBe(false);
    const required = [...form.querySelectorAll("[required]")].map((field) => field.id);
    expect(required).toEqual(["name", "email", "pickup"]);
    expect(form.querySelector("#email")?.getAttribute("type")).toBe("email");
    expect(form.querySelector("#pickup")?.getAttribute("type")).toBe("date");
    expect(form.querySelectorAll('button:not([type]), button[type="submit"]')).toHaveLength(1);
  });

  it("comes back to a page of this site once the order is in", () => {
    const back = dom("index.html").querySelector('form input[name="_redirect"]');
    expect(existsSync(join(DIST, back!.getAttribute("value")!, "index.html"))).toBe(true);
  });

  it("sends every ticked item under one name, as a checkbox group", () => {
    const boxes = dom("index.html").querySelectorAll('form input[type="checkbox"]');
    expect(boxes.length).toBeGreaterThan(1);
    expect(new Set([...boxes].map((box) => box.getAttribute("name")))).toEqual(new Set(["items"]));
  });
});

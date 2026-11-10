/** Accessibility gate. */

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
  { name: "not found", file: "404.html" },
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
      // Colour contrast needs real layout, which jsdom does not do.
      rules: { "color-contrast": { enabled: false } },
    });

    const summary = results.violations.map(
      (v) => `${v.id} (${v.impact}): ${v.help}: ${v.nodes.length} node(s)`,
    );
    expect(summary).toEqual([]);
  });

  it("ships no JavaScript: its script elements are speculation rules and structured data, which the browser reads as data", () => {
    const html = readFileSync(join(DIST, file), "utf8");
    const { document } = new JSDOM(html).window;
    const scripts = [...document.querySelectorAll("script")];
    const types = scripts.map((script) => script.type);
    expect(types.filter((type) => type !== "application/ld+json")).toEqual(["speculationrules"]);
    for (const script of scripts) expect(script.src).toBe("");
    const rules = JSON.parse(scripts.at(-1)!.textContent ?? "") as { prerender: unknown[] };
    expect(rules.prerender.length).toBeGreaterThan(0);
  });

  it("can be found and shared: a description, an address of its own, and a card with an image", () => {
    const html = readFileSync(join(DIST, file), "utf8");
    const { document } = new JSDOM(html).window;
    const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content");
    expect(meta('meta[name="description"]')?.length).toBeGreaterThan(0);
    expect(meta('meta[property="og:title"]')).toBe(document.title);
    expect(meta('meta[property="og:image"]')).toBe("https://example.com/og.png");
    expect(meta('meta[name="twitter:card"]')).toBe("summary_large_image");
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    // A page with no address worth indexing says so instead of naming one.
    if (meta('meta[name="robots"]') === "noindex") expect(canonical).toBeUndefined();
    else expect(canonical).toBe(`https://example.com/${file.replace(/index\.html$/, "")}`);
  });

  it("links only to pages that were built", () => {
    const html = readFileSync(join(DIST, file), "utf8");
    const { document } = new JSDOM(html).window;
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
      const path = link.getAttribute("href")!.split("#")[0]!;
      expect(existsSync(join(DIST, path, "index.html")), `${file}: ${path}`).toBe(true);
    }
  });

  it("links every page at the address it is built at, so no click waits on a redirect", () => {
    const html = readFileSync(join(DIST, file), "utf8");
    const { document } = new JSDOM(html).window;
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
      const href = link.getAttribute("href")!.split("#")[0]!;
      if (href) expect(href, `${file}: ${href}`).toMatch(/\/$/);
    }
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

describe("for search engines", () => {
  it("lists every page worth finding in the sitemap, and points robots.txt at it", () => {
    const sitemap = readFileSync(join(DIST, "sitemap.xml"), "utf8");
    const listed = [...sitemap.matchAll(/<loc>https:\/\/example\.com([^<]*)<\/loc>/g)].map(
      (match) => match[1]!,
    );
    expect(listed.toSorted()).toEqual(["/", "/about/", "/blog/", "/blog/publish-from-anywhere/"]);
    for (const path of listed) expect(existsSync(join(DIST, path, "index.html")), path).toBe(true);
    expect(readFileSync(join(DIST, "robots.txt"), "utf8")).toContain(
      "Sitemap: https://example.com/sitemap.xml",
    );
    expect(existsSync(join(DIST, "og.png"))).toBe(true);
  });

  it("describes a post as an article, with its date", () => {
    const html = readFileSync(join(DIST, "blog/publish-from-anywhere/index.html"), "utf8");
    const { document } = new JSDOM(html).window;
    const data = JSON.parse(
      document.querySelector('script[type="application/ld+json"]')!.textContent!,
    ) as Record<string, string>;
    expect(data["@type"]).toBe("BlogPosting");
    expect(data.headline).toBe("Publish from anywhere");
    expect(data.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/** Performance budget. */
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

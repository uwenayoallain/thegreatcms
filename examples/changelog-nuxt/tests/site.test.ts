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
    // Speculation rules and structured data are read by the browser and by crawlers; neither runs.
    const scripts = [...dom(file).querySelectorAll("script")].filter(
      (s) => !["speculationrules", "application/ld+json"].includes(s.getAttribute("type") ?? ""),
    );
    expect(scripts).toHaveLength(0);
  });

  it("can be found and shared: a description, an address of its own, and a card with an image", () => {
    const document = dom(file);
    const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content");
    expect(meta('meta[name="description"]')?.length).toBeGreaterThan(0);
    expect(meta('meta[property="og:description"]')).toBe(meta('meta[name="description"]'));
    expect(meta('meta[property="og:title"]')).toBe(document.title);
    expect(meta('meta[property="og:image"]')).toBe("https://sundial.example/og.png");
    expect(meta('meta[name="twitter:card"]')).toBe("summary_large_image");
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    // A page with no address worth indexing says so instead of naming one.
    if (meta('meta[name="robots"]') === "noindex") expect(canonical).toBeUndefined();
    else expect(canonical).toBe(`https://sundial.example/${file.replace(/index\.html$/, "")}`);
  });

  it("links only to pages that were built", () => {
    for (const link of dom(file).querySelectorAll('a[href^="/"]')) {
      const path = link.getAttribute("href")!.split("#")[0]!;
      expect(existsSync(join(DIST, path, "index.html")), `${file}: ${path}`).toBe(true);
    }
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

describe("for search engines", () => {
  it("lists every page worth finding in the sitemap, points robots.txt at it, and publishes the share image", () => {
    const listed = [
      ...read("sitemap.xml").matchAll(/<loc>https:\/\/sundial\.example([^<]*)<\/loc>/g),
    ]
      .map((match) => match[1]!)
      .toSorted();
    const expected = ["/", "/changelog/", ...RELEASES.map((slug) => `/changelog/${slug}/`)];
    expect(listed).toEqual(expected.toSorted());
    for (const path of listed) expect(existsSync(join(DIST, path, "index.html")), path).toBe(true);
    expect(read("robots.txt")).toContain("Sitemap: https://sundial.example/sitemap.xml");
    expect(existsSync(join(DIST, "og.png"))).toBe(true);
  });

  it("describes the product on the home page and each release as an article with its date", () => {
    const data = (file: string) =>
      JSON.parse(
        dom(file).querySelector('script[type="application/ld+json"]')!.textContent!,
      ) as Record<string, string>;
    expect(data("index.html")["@type"]).toBe("SoftwareApplication");
    for (const slug of RELEASES) {
      const release = data(`changelog/${slug}/index.html`);
      expect(release["@type"]).toBe("Article");
      expect(release.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

/** The docs site holds itself to the same bars as everything else: no JavaScript. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const DIST = join(new URL("..", import.meta.url).pathname, "dist");
const ROOT = join(DIST, "../../..");

const PAGES = [
  { name: "landing", file: "index.html" },
  { name: "docs index", file: "docs/index.html" },
  { name: "a docs page", file: "docs/getting-started/index.html" },
  { name: "the command line", file: "docs/the-command-line/index.html" },
  { name: "the standard", file: "spec/index.html" },
  { name: "not found", file: "404.html" },
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const kilobytes = (files: string[]) =>
  files.reduce((total, file) => total + statSync(file).size, 0) / 1024;

const read = (file: string) => readFileSync(join(DIST, file), "utf8");

// Parsing a page is the slow part of this suite, and nothing here mutates one, so each is parsed once.
const parsed = new Map<string, Document>();
const dom = (file: string) => {
  let document = parsed.get(file);
  if (!document) {
    document = new JSDOM(read(file)).window.document;
    parsed.set(file, document);
  }
  return document;
};

/** Every link on a built page; a pattern is enough for HTML this site generated itself. */
const links = (html: string) => [...html.matchAll(/<a\s[^>]*?href="([^"]+)"/g)].map((m) => m[1]!);

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in apps/docs before these tests.");
  }
});

describe.each(PAGES)("$name", ({ file }) => {
  it("has no axe violations", async () => {
    const { window } = new JSDOM(read(file), {
      pretendToBeVisual: true,
      url: "https://greatcms.uwe.rw/",
    });
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });

    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      // jsdom has no layout, so contrast cannot be measured here.
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("ships no JavaScript", () => {
    expect(read(file)).not.toMatch(/<script/i);
  });

  it("has a language, a title, one h1, and a skip link", () => {
    const document = dom(file);
    expect(document.documentElement.lang).toBe("en");
    expect(document.title.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("a.skip-link")?.getAttribute("href")).toBe("#main");
  });

  it("is findable and shareable without a script", () => {
    const document = dom(file);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toMatch(
      /^https:\/\/greatcms\.uwe\.rw\//,
    );
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
      document.title,
    );
    const icons = [...document.querySelectorAll('link[rel="icon"]')].map((l) =>
      l.getAttribute("href"),
    );
    expect(icons).toEqual(["/favicon.ico", "/favicon.svg"]);
    for (const asset of [
      "favicon.ico",
      "favicon.svg",
      "apple-touch-icon.png",
      "site.webmanifest",
    ]) {
      expect(existsSync(join(DIST, asset)), `${asset} is published`).toBe(true);
    }
  });
});

describe("the landing page", () => {
  it("renders content the CMS manages", () => {
    const document = dom("index.html");

    // Straight from content/cms/home.hero.json and home.claims.json.
    expect(document.querySelector("h1")?.textContent).toContain(
      "A CMS your site does not depend on",
    );
    expect(document.querySelectorAll(".claims li").length).toBeGreaterThanOrEqual(4);
    expect(document.body.textContent).toContain("Nothing at runtime");
  });

  it("says plainly that it is managed by the thing it describes", () => {
    expect(read("index.html")).toContain("managed by the thing it describes");
  });

  it("shows the three files that make up the integration", () => {
    const names = [...dom("index.html").querySelectorAll(".file-list h3")].map((h) =>
      h.textContent?.trim(),
    );
    expect(names).toEqual([
      ".cms/schema.yaml",
      "content/cms/home.hero.json",
      "src/pages/index.astro",
    ]);
  });

  it("links the standard as well as getting started", () => {
    const hrefs = [...dom("index.html").querySelectorAll(".hero a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/docs/getting-started/");
    expect(hrefs).toContain("/spec/");
  });
});

describe("the docs", () => {
  it("builds a page per collection entry, in schema order", () => {
    const titles = [...dom("docs/index.html").querySelectorAll(".index-list h2")].map((h) =>
      h.textContent?.trim(),
    );

    expect(titles[0]).toBe("Getting started");
    expect(titles[1]).toBe("The command line");
    expect(titles).toContain("Accessibility");
    expect(titles).toContain("Running the studio");
    expect(titles).toContain("Any language");
    expect(titles).toContain("The examples");
    expect(titles.length).toBeGreaterThanOrEqual(10);
  });

  it("gives every heading an id and a link to itself", () => {
    const document = dom("docs/the-command-line/index.html");
    const headings = [...document.querySelectorAll(".prose h2")];
    expect(headings.length).toBeGreaterThanOrEqual(5);
    for (const heading of headings) {
      expect(heading.id).toMatch(/^[a-z0-9-]+$/);
      expect(heading.querySelector(`a.anchor[href="#${heading.id}"]`)).not.toBeNull();
    }
    const ids = headings.map((heading) => heading.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("outlines a long page, and leaves a short one alone", () => {
    const long = dom("docs/the-command-line/index.html");
    const items = [...long.querySelectorAll(".on-this-page a")].map((a) => a.getAttribute("href"));
    expect(items).toContain("#greatcms-check");
    for (const href of items) expect(long.querySelector(href!)).not.toBeNull();
    // The rail beside the article on wide screens lists the same headings as the copy inside it.
    const hrefs = (selector: string) =>
      [...long.querySelectorAll(`${selector} a`)].map((a) => a.getAttribute("href"));
    expect(hrefs(".on-this-page.rail")).toEqual(hrefs(".prose .on-this-page"));

    expect(dom("docs/accessibility/index.html").querySelector(".on-this-page")).toBeNull();
  });

  it("walks from page to page in order", () => {
    const document = dom("docs/the-command-line/index.html");
    expect(document.querySelector('.pager a[rel="prev"]')?.getAttribute("href")).toBe(
      "/docs/getting-started/",
    );
    expect(document.querySelector('.pager a[rel="next"]')?.getAttribute("href")).toBe(
      "/docs/the-hybrid-model/",
    );
    expect(
      dom("docs/examples/index.html").querySelector('.pager a[rel="next"]')?.getAttribute("href"),
    ).toBe("/spec/");
  });

  it("sizes every image and describes it, so none moves the page or goes unread", () => {
    const images = walk(DIST)
      .filter((file) => file.endsWith(".html"))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/<img\s[^>]*>/g)].map((m) => m[0]),
      );
    expect(images.filter((img) => img.includes("/screens/")).length).toBeGreaterThanOrEqual(3);
    for (const img of images) {
      expect(img, img).toMatch(/\swidth="\d+"/);
      expect(img, img).toMatch(/\sheight="\d+"/);
      if (img.includes("/screens/")) expect(img, img).toMatch(/\salt="[^"]{40,}"/);
    }
  });

  it("renders the standard from SPEC.md, so the two cannot drift", () => {
    const html = read("spec/index.html");
    expect(html).toContain("Resolution rules");
    expect(html).toContain("decorative-allowed");
    expect(html).toContain('id="6-resolution-rules-the-important-part"');
  });

  it("has no dead internal links, and every anchor lands on a heading that exists", () => {
    const pages = walk(DIST).filter((file) => file.endsWith(".html"));
    const html = new Map(pages.map((page) => [page, readFileSync(page, "utf8")]));
    const missing: string[] = [];
    for (const [page, source] of html) {
      for (const href of links(source)) {
        if (!href.startsWith("/") && !href.startsWith("#")) continue;
        const [path, fragment] = href.split("#") as [string, string | undefined];
        const target = !path
          ? page
          : path.endsWith("/")
            ? join(DIST, path, "index.html")
            : join(DIST, path);
        if (!existsSync(target)) {
          missing.push(`${page.slice(DIST.length)} -> ${href}`);
          continue;
        }
        const body = html.get(target);
        if (fragment && body && !body.includes(`id="${fragment}"`)) {
          missing.push(`${page.slice(DIST.length)} -> ${href} (no such anchor)`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("the agent surface", () => {
  it("serves every entrypoint docs.json names", () => {
    const manifest = JSON.parse(read("docs.json"));
    for (const path of Object.values<string>(manifest.agentEntrypoints)) {
      expect(existsSync(join(DIST, path)), path).toBe(true);
    }
    for (const page of manifest.pages) {
      expect(existsSync(join(DIST, page.markdownUrl)), page.markdownUrl).toBe(true);
      const html = page.url === "/" ? "index.html" : join(page.url, "index.html");
      expect(existsSync(join(DIST, html)), page.url).toBe(true);
    }
  });

  it("serves the standard and the JSON Schemas straight from the repository", () => {
    expect(read("spec.md")).toBe(readFileSync(join(ROOT, "SPEC.md"), "utf8"));
    expect(read("index.md")).toBe(readFileSync(join(ROOT, "README.md"), "utf8"));
    for (const name of ["schema.schema.json", "config.schema.json"]) {
      expect(read(`json-schema/${name}`)).toBe(
        readFileSync(join(ROOT, "packages/spec/json-schema", name), "utf8"),
      );
    }
  });

  it("lists every docs page in llms.txt and llms-full.txt", () => {
    const slugs = readdirSync(join(DIST, "docs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(slugs.length).toBeGreaterThanOrEqual(10);
    const llms = read("llms.txt");
    const full = read("llms-full.txt");
    for (const slug of slugs) {
      expect(llms, slug).toContain(`https://greatcms.uwe.rw/docs/${slug}.md`);
      expect(full, slug).toContain(`url: https://greatcms.uwe.rw/docs/${slug}`);
    }
  });

  it("serves each docs page as the Markdown it was written in", () => {
    const markdown = read("docs/publishing.md");
    expect(markdown.startsWith("# Publishing\n")).toBe(true);
    expect(markdown).toContain("## One commit, or none");
  });

  it("has a sitemap that matches the pages built", () => {
    const sitemap = read("sitemap.xml");
    const pages = walk(DIST)
      .filter((file) => file.endsWith("index.html"))
      .map((file) => file.slice(DIST.length, -"index.html".length));
    for (const page of pages)
      expect(sitemap).toContain(`<loc>https://greatcms.uwe.rw${page}</loc>`);
    expect(sitemap).not.toContain("/404");
    expect(read("robots.txt")).toContain("Sitemap: https://greatcms.uwe.rw/sitemap.xml");
  });
});

describe("weight", () => {
  it("keeps every page's HTML small", () => {
    for (const page of PAGES) {
      const size = statSync(join(DIST, page.file)).size / 1024;
      expect(size, `${page.name} is ${size.toFixed(1)} KB`).toBeLessThan(45);
    }
  });

  it("keeps the pages people read well under budget", () => {
    const files = walk(DIST).filter((file) => /\.(html|css)$/.test(file));
    const total = kilobytes(files);
    expect(total, `${total.toFixed(1)} KB of HTML and CSS`).toBeLessThan(270);
  });

  it("keeps scroll timelines where browsers read them, not folded into the shorthand", () => {
    const css = walk(DIST)
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(file, "utf8"))
      .join("");
    expect(css).not.toMatch(/animation:[^;}]*(view\(|scroll\()/);
  });

  it("ships one small stylesheet and no scripts", () => {
    const files = walk(DIST);
    expect(files.filter((file) => file.endsWith(".js"))).toEqual([]);
    const css = files.filter((file) => file.endsWith(".css"));
    expect(css).toHaveLength(1);
    // Three font faces and the highlighter's classes ride in the one stylesheet.
    expect(kilobytes(css)).toBeLessThan(24);
  });
});

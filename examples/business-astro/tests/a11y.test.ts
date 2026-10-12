import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const DIST = join(new URL("..", import.meta.url).pathname, "dist");
const PAGES = [
  { name: "home", file: "index.html" },
  { name: "about", file: "about/index.html" },
  { name: "products", file: "products/index.html" },
  {
    name: "product detail",
    file: "products/climbing-bean-seed/index.html",
  },
  { name: "contact", file: "contact/index.html" },
  { name: "privacy policy", file: "privacy-policy/index.html" },
  { name: "terms of service", file: "terms-of-service/index.html" },
  { name: "not found", file: "404.html" },
];

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/business-astro before the tests.");
  }
});

describe.each(PAGES)("$name", ({ file }) => {
  it("has no axe violations", async () => {
    const html = readFileSync(join(DIST, file), "utf8");
    const dom = new JSDOM(html, { pretendToBeVisual: true, url: "https://example.com/" });
    const { window } = dom;
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).document = window.document;
    (globalThis as Record<string, unknown>).Node = window.Node;

    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("ships no JavaScript", () => {
    expect(readFileSync(join(DIST, file), "utf8")).not.toMatch(/<script/i);
  });

  it("has the page landmarks", () => {
    const { document } = new JSDOM(readFileSync(join(DIST, file), "utf8")).window;
    expect(document.documentElement.lang).toBe("en");
    expect(document.title.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("a.skip-link")?.getAttribute("href")).toBe("#main");
    expect(document.querySelector("main")?.id).toBe("main");
  });
});

describe("business content", () => {
  it("renders schema-driven sections and collection entries", () => {
    const home = new JSDOM(readFileSync(join(DIST, "index.html"), "utf8")).window.document;
    const products = new JSDOM(readFileSync(join(DIST, "products/index.html"), "utf8")).window
      .document;

    expect(home.querySelectorAll("main > section")).toHaveLength(8);
    expect(home.querySelectorAll(".process-track > li")).toHaveLength(4);
    expect(home.querySelectorAll(".product-card")).toHaveLength(2);
    expect(products.querySelectorAll(".product-card")).toHaveLength(3);
  });

  it("turns managed pages into routes, navigation, and legal links", () => {
    const home = new JSDOM(readFileSync(join(DIST, "index.html"), "utf8")).window.document;
    const about = new JSDOM(readFileSync(join(DIST, "about/index.html"), "utf8")).window.document;
    const privacy = new JSDOM(readFileSync(join(DIST, "privacy-policy/index.html"), "utf8")).window
      .document;

    expect(home.querySelector('nav[aria-label="Main navigation"] a[href="/about"]')).toBeTruthy();
    expect(home.querySelectorAll('nav[aria-label="Legal"] a')).toHaveLength(2);
    expect(about.querySelectorAll("main > section")).toHaveLength(3);
    expect(privacy.querySelector(".managed-prose h2")?.textContent).toBe(
      "Information sent through the form",
    );
  });

  it("turns every product into a useful detail page", () => {
    const { document } = new JSDOM(
      readFileSync(join(DIST, "products/climbing-bean-seed/index.html"), "utf8"),
    ).window;

    expect(document.querySelector("h1")?.textContent).toBe("Climbing bean seed");
    expect(document.querySelectorAll(".product-spec section")).toHaveLength(2);
    expect(document.querySelectorAll(".product-spec li")).toHaveLength(4);
  });

  it("keeps the contact workflow as a labelled plain form POST", () => {
    const { document } = new JSDOM(readFileSync(join(DIST, "contact/index.html"), "utf8")).window;
    const form = document.querySelector("form.field-form");

    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form?.getAttribute("action")).toBeTruthy();
    for (const control of form?.querySelectorAll("input:not([type=hidden]), textarea") ?? []) {
      const id = control.getAttribute("id");
      expect(id).toBeTruthy();
      expect(document.querySelector(`label[for="${id}"]`)).toBeTruthy();
    }
    expect(form?.querySelector(".trap")?.getAttribute("aria-hidden")).toBe("true");
    expect(form?.querySelector(".trap input")?.getAttribute("tabindex")).toBe("-1");
    expect(document.querySelector(".contact-person strong")?.textContent).toBe("Aline Mukamana");
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

const kilobytes = (files: string[]) =>
  files.reduce((total, file) => total + statSync(file).size, 0) / 1024;

describe("weight", () => {
  it("keeps the whole site under 140 KB", () => {
    expect(kilobytes(walk(DIST))).toBeLessThan(140);
  });

  it("keeps every page under 25 KB", () => {
    for (const page of PAGES) {
      expect(statSync(join(DIST, page.file)).size / 1024).toBeLessThan(25);
    }
  });

  it("ships one small stylesheet and no JavaScript assets", () => {
    const files = walk(DIST);
    const css = files.filter((file) => file.endsWith(".css"));
    const js = files.filter((file) => /\.(m?js)$/.test(file));
    expect(css).toHaveLength(1);
    expect(kilobytes(css)).toBeLessThan(25);
    expect(js).toEqual([]);
  });
});

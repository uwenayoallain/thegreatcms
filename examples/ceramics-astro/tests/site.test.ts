/** Ibumba, checked as built: accessible, script-free, and every word from its content. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const WORKSHOPS = readdirSync(join(ROOT, "src/content/workshops")).map((file) =>
  file.replace(/\.md$/, ""),
);
const PAGES = [
  "index.html",
  "workshops/index.html",
  "visit/index.html",
  "book/index.html",
  "book/thanks/index.html",
  "404.html",
  ...WORKSHOPS.map((slug) => `workshops/${slug}/index.html`),
];

const read = (file: string) => readFileSync(join(DIST, file), "utf8");
const dom = (file: string) => new JSDOM(read(file)).window.document;
const region = (id: string) =>
  JSON.parse(readFileSync(join(ROOT, "src/content/cms", `${id}.json`), "utf8"));

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html")))
    throw new Error("Run `pnpm build` in examples/ceramics-astro first.");
});

describe.each(PAGES)("%s", (file) => {
  it("has no axe violations", async () => {
    const { window } = new JSDOM(read(file), {
      pretendToBeVisual: true,
      url: "https://ibumba.example/",
    });
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });
    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      // jsdom has no layout, so contrast is not measurable here.
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it("has a language, a title, one h1 and a way past the header", () => {
    const document = dom(file);
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toMatch(/Ibumba/);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("a.skip")?.getAttribute("href")).toBe("#main");
  });

  it("ships no JavaScript, only speculation rules data, and none of the studio's preview", () => {
    const scripts = [...dom(file).querySelectorAll("script")];
    expect(scripts.map((script) => script.type)).toEqual(["speculationrules"]);
    const rules = JSON.parse(scripts[0]!.textContent ?? "") as { prerender: unknown[] };
    expect(rules.prerender.length).toBeGreaterThan(0);
    expect(read(file)).not.toContain("data-greatcms");
  });

  it("names each element that carries over between pages once, so a page change knows what became what", () => {
    const names = [...read(file).matchAll(/view-transition-name:\s*([\w-]+)/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("links every internal page at its built address without a redirect", () => {
    for (const link of dom(file).querySelectorAll('a[href^="/"]')) {
      const href = link.getAttribute("href")!.split("#")[0]!.split("?")[0]!;
      if (!href) continue;
      expect(href, `${file}: ${href}`).toMatch(/\/$/);
      expect(existsSync(join(DIST, href, "index.html")), `${file}: ${href} is not built`).toBe(
        true,
      );
    }
  });
});

describe("content", () => {
  it("renders the hero and every home section the studio manages, in order", () => {
    const home = dom("index.html");
    expect(home.querySelector("h1")?.textContent).toBe(region("home.hero").heading);
    const order = [...home.querySelectorAll("main > section:not(.hero), main > figure")].map(
      (element) => element.className.split(" ")[0],
    );
    const types = region("home.sections").blocks.map((block: { _type: string }) => block._type);
    expect(order).toEqual(types);
  });

  it("gives every workshop a page, and lists the ones still to come, soonest first", () => {
    for (const slug of WORKSHOPS) {
      expect(existsSync(join(DIST, "workshops", slug, "index.html"))).toBe(true);
    }
    const dates = [...dom("workshops/index.html").querySelectorAll("main time")].map((time) =>
      time.getAttribute("datetime")!,
    );
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.map(Date.parse)).toEqual(dates.map(Date.parse).toSorted((a, b) => a - b));
  });

  it("shows a workshop's time in Kigali, whatever zone it was built in", () => {
    const page = dom("workshops/first-evening-at-the-wheel/index.html");
    expect(page.querySelector("main time")?.textContent).toContain("18:00");
  });

  it("does not offer a booking for a full workshop", () => {
    const full = dom("workshops/glaze-chemistry-evening/index.html");
    expect(full.querySelector('a[href^="/book/"].button')).toBeNull();
    expect(full.querySelector(".badge")?.textContent).toMatch(/fully booked/i);
    const options = [...dom("book/index.html").querySelectorAll("#workshop option")].map(
      (option) => option.textContent,
    );
    expect(options.join(" ")).not.toContain("Glaze chemistry");
  });
});

describe("the booking form", () => {
  it("posts to the studio's inbox, labels every field, and returns to a thank-you page", () => {
    const document = dom("book/index.html");
    const form = document.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("POST");
    expect(form.getAttribute("action")).toMatch(/\/f\/[\w-]+\/booking$/);
    expect(form.querySelector<HTMLInputElement>('[name="_redirect"]')?.value).toBe("/book/thanks/");
    for (const control of form.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      expect(document.querySelector(`label[for="${control.id}"]`), control.id).toBeTruthy();
    }
    expect(form.querySelector('[name="company"]')?.getAttribute("tabindex")).toBe("-1");
  });
});

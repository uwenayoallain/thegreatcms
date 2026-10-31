/** The showcase, checked as built: accessible, light, honest about motion, and driven by its content. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const WORK = readdirSync(join(ROOT, "content/work")).map((file) => file.replace(/\.json$/, ""));
const PAGES = [
  "index.html",
  "work/index.html",
  "contact/index.html",
  "404.html",
  ...WORK.map((slug) => `work/${slug}/index.html`),
];

const read = (file: string) => readFileSync(join(DIST, file), "utf8");
const dom = (file: string) => new JSDOM(read(file)).window.document;
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const kilobytes = (files: string[]) =>
  files.reduce((total, file) => total + statSync(file).size, 0) / 1024;

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html")))
    throw new Error("Run `pnpm build` in examples/studio-astro first.");
});

describe.each(PAGES)("%s", (file) => {
  it("has no axe violations", async () => {
    const { window } = new JSDOM(read(file), {
      pretendToBeVisual: true,
      url: "https://paraline.example/",
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
    expect(document.title).toMatch(/Paraline/);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("a.skip")?.getAttribute("href")).toBe("#main");
  });

  it("names each morphing element once, so a page change knows what became what", () => {
    const names = [...read(file).matchAll(/view-transition-name:\s*([\w-]+)/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("content", () => {
  it("renders the hero the studio manages, with every rotating word readable", () => {
    const hero = JSON.parse(readFileSync(join(ROOT, "content/cms/home.hero.json"), "utf8"));
    const h1 = dom("index.html").querySelector("h1")!.textContent!.replace(/\s+/g, " ");
    for (const line of hero.lines) expect(h1).toContain(line);
    expect(h1).toContain(hero.rotating[0]);
  });

  it("gives every project a case study, and features only the featured ones", () => {
    const home = dom("index.html");
    const featured = WORK.filter(
      (slug) =>
        JSON.parse(readFileSync(join(ROOT, "content/work", `${slug}.json`), "utf8")).featured,
    );
    const linked = [...home.querySelectorAll(".work a.work-card")].map((a) =>
      a.getAttribute("href"),
    );
    expect(linked.toSorted()).toEqual(featured.map((slug) => `/work/${slug}/`).toSorted());
    for (const slug of WORK) expect(existsSync(join(DIST, "work", slug, "index.html"))).toBe(true);
  });

  it("keeps the real figure in the page while the display counts up", () => {
    const numbers = [...dom("index.html").querySelectorAll(".count")];
    expect(numbers.length).toBeGreaterThan(0);
    for (const count of numbers) {
      expect(count.querySelector(".count__value")?.textContent).toMatch(/^\d+$/);
      expect(count.querySelector(".count__digits")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("posts the contact form to the studio's inbox, plainly and with a trap for bots", () => {
    const form = dom("contact/index.html").querySelector("form")!;
    expect(form.getAttribute("method")).toBe("POST");
    expect(form.getAttribute("action")).toMatch(/\/f\/[^/]+\/contact$/);
    expect(form.querySelector('[name="_redirect"]')?.getAttribute("value")).toBe("/contact/#sent");
    expect(form.querySelector('[name="company"]')?.getAttribute("tabindex")).toBe("-1");
    for (const name of ["name", "email", "message"])
      expect(form.querySelector(`[name="${name}"]`)).not.toBeNull();
  });

  it("has no internal link to a page that was not built", () => {
    for (const file of PAGES) {
      for (const anchor of dom(file).querySelectorAll("a[href^='/']")) {
        const path = anchor.getAttribute("href")!.split("#")[0]!;
        const target = path.endsWith("/") ? join(DIST, path, "index.html") : join(DIST, path);
        expect(existsSync(target), `${file} → ${path}`).toBe(true);
      }
    }
  });
});

/** The stylesheet with every `@media (prefers-reduced-motion: no-preference)` block cut out. */
function withoutMotionBlocks(text: string): string {
  const opener = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/g;
  let out = "";
  let from = 0;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    out += text.slice(from, match.index);
    let depth = 1;
    let at = opener.lastIndex;
    while (depth > 0 && at < text.length) {
      if (text[at] === "{") depth += 1;
      else if (text[at] === "}") depth -= 1;
      at += 1;
    }
    from = at;
    opener.lastIndex = at;
  }
  return out + text.slice(from);
}

describe("motion", () => {
  const css = () =>
    walk(DIST)
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(file, "utf8"))
      .join("");
  const js = () => walk(DIST).filter((file) => file.endsWith(".js"));

  it("starts every animation only for visitors who have not asked for less", () => {
    // Outside the no-preference blocks, nothing names an animation.
    expect(withoutMotionBlocks(css())).not.toMatch(/animation(-name)?:\s*[a-z]/);
    expect(css()).toMatch(/prefers-reduced-motion:\s*no-preference/);
  });

  it("keeps every scroll timeline where browsers read it, not folded into the shorthand", () => {
    // A minifier that writes `animation: … view()` produces a declaration browsers drop whole.
    expect(css()).not.toMatch(/animation:[^;}]*(view\(|scroll\(|--[a-z]+(?=[;}]))/);
    expect(css()).toMatch(/animation-timeline:\s*view\(\)/);
  });

  it("ships one small script that stands down for reduced motion", () => {
    const files = js();
    expect(files).toHaveLength(1);
    expect(kilobytes(files)).toBeLessThan(24);
    expect(readFileSync(files[0]!, "utf8")).toContain("prefers-reduced-motion: reduce");
  });

  it("keeps pages and the stylesheet light", () => {
    for (const file of PAGES) expect(statSync(join(DIST, file)).size / 1024, file).toBeLessThan(30);
    expect(kilobytes(walk(DIST).filter((file) => file.endsWith(".css")))).toBeLessThan(40);
  });
});

/** Layout in a browser: no page scrolls sideways, nothing shared moves between pages, nothing shifts as a page loads. */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, relative } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST = join(new URL("..", import.meta.url).pathname, "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};

/** Every built page, as the address a visitor opens. */
function pages(dir = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === "index.html" ? [`/${relative(DIST, dir)}/`.replace("//", "/")] : [];
  });
}

async function launch(): Promise<Browser | null> {
  const { chromium } = await import("playwright");
  // Scrollbars take room, as they do on most desktops, so a page that gains one would show it.
  const options = { ignoreDefaultArgs: ["--hide-scrollbars"] };
  return chromium
    .launch(options)
    .catch(() => chromium.launch({ ...options, channel: "chromium" }))
    .catch(() => chromium.launch({ ...options, channel: "chrome" }))
    .catch(() => {
      console.warn(
        "No Chromium available: layout tests skipped. `pnpm exec playwright install chromium`.",
      );
      return null;
    });
}

const browser = await launch();
let server: Server;
let origin: string;

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in apps/docs before the layout tests.");
  }
  if (!browser) return;
  server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]!));
    const candidate = join(DIST, path);
    const file =
      existsSync(candidate) && statSync(candidate).isDirectory()
        ? join(candidate, "index.html")
        : candidate;
    if (path.includes("..") || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe.skipIf(!browser)("on a phone", () => {
  // 320px is the narrowest phone still in use, and what a 1280px window zoomed to 400% lays out as.
  it.each(pages())("%s fits the screen", async (path) => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      for (const width of [390, 320]) {
        // oxlint-disable-next-line no-await-in-loop -- one tab, resized
        await page.setViewportSize({ width, height: 844 });
        // oxlint-disable-next-line no-await-in-loop
        await page.goto(origin + path, { waitUntil: "load" });
        // A phone draws its scrollbar over the page; this browser takes room for it, so give that room back.
        // oxlint-disable-next-line no-await-in-loop
        const bar = await page.evaluate(() => innerWidth - document.documentElement.clientWidth);
        // oxlint-disable-next-line no-await-in-loop
        await page.setViewportSize({ width: width + bar, height: 844 });
        // oxlint-disable-next-line no-await-in-loop
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${path} scrolls sideways by ${overflow}px at ${width}px`).toBe(0);
      }
    } finally {
      await page.close();
    }
  });
});

const WIDTHS = [375, 768, 1024, 1280, 1600];

/** Adds up layout shifts from the first paint on, for the page to report once it has settled. */
const recordShifts = () => {
  const shifts = { total: 0 };
  Object.assign(window, { layoutShifts: shifts });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { value: number })[]) {
      shifts.total += entry.value;
    }
  }).observe({ type: "layout-shift", buffered: true });
};

/** Where the shared pieces landed, and how far anything moved on the way. */
const measure = () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- this runs in the page, which sees nothing outside
  const box = (selector: string) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect && [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 10) / 10);
  };
  const footer = box(".colophon");
  return {
    shift: (window as unknown as { layoutShifts: { total: number } }).layoutShifts.total,
    header: box(".masthead"),
    nav: box(".masthead nav"),
    // The footer sits lower on a longer page; only its size and left edge are shared.
    footer: footer && [footer[0], footer[2], footer[3]],
    docsNav: box(".docs-nav"),
    content: box(".docs > .prose")?.slice(0, 3),
  };
};

type Measured = ReturnType<typeof measure>;

async function settle(page: Page, path: string, wait: number): Promise<Measured> {
  await page.goto(origin + path, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(wait);
  return page.evaluate(measure);
}

/** Every page in turn in one tab, as a reader clicking through would see them. */
async function walkAll(width: number): Promise<Map<string, Measured>> {
  const context = await browser!.newContext({ viewport: { width, height: 1200 } });
  const page = await context.newPage();
  await page.addInitScript(recordShifts);
  const results = new Map<string, Measured>();
  try {
    // The not-found page is short enough not to scroll at all, which is the case a scrollbar would give away.
    for (const path of [...pages(), "/404.html"]) {
      // oxlint-disable-next-line no-await-in-loop -- one tab, one page after another, like a reader
      results.set(path, await settle(page, path, 150));
    }
  } finally {
    await context.close();
  }
  return results;
}

/** One value for every page; a page that disagrees with the first is named. */
function expectShared(results: Map<string, Measured>, key: keyof Measured, what: string) {
  const found = [...results].filter(([, result]) => result[key] !== undefined);
  for (const [path, result] of found.slice(1)) {
    expect(result[key], `${what} on ${path} differs from ${found[0]![0]}`).toEqual(
      found[0]![1][key],
    );
  }
  return found.length;
}

describe.skipIf(!browser)("between pages", () => {
  it.each(WIDTHS)(
    "at %ipx the chrome and the docs columns stay put, and nothing shifts while loading",
    async (width) => {
      const results = await walkAll(width);
      expectShared(results, "header", "the header");
      expectShared(results, "nav", "the site navigation");
      expectShared(results, "footer", "the footer");
      expectShared(results, "docsNav", "the docs sidebar");
      expect(expectShared(results, "content", "the article column")).toBeGreaterThan(10);
      for (const [path, result] of results) {
        expect(result.shift, `${path} shifts by ${result.shift}`).toBe(0);
      }
    },
    // Every page in one tab takes seconds alone, and far longer beside the other browser suites.
    120_000,
  );

  // A slow font is where a swap would move text: the face is optional, so it never swaps in late.
  it.each([375, 1280])("at %ipx nothing shifts when the fonts arrive late", async (width) => {
    const context = await browser!.newContext({ viewport: { width, height: 1200 } });
    const page = await context.newPage();
    await page.addInitScript(recordShifts);
    await page.route("**/*.woff2", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    try {
      for (const path of ["/", "/docs/", "/docs/the-command-line/", "/spec/"]) {
        // oxlint-disable-next-line no-await-in-loop -- each page has to load alone for its fonts to be late
        const { shift } = await settle(page, path, 550);
        expect(shift, `${path} shifts by ${shift}`).toBe(0);
      }
    } finally {
      await context.close();
    }
  });

  // The face is optional, so any visit may be drawn in the stand-in: the frame must not depend on which.
  it.each([375, 1280])(
    "at %ipx the chrome sits in the same place with the web font and without it",
    async (width) => {
      const frame = async (blocked: boolean) => {
        const context = await browser!.newContext({ viewport: { width, height: 1200 } });
        const page = await context.newPage();
        await page.addInitScript(recordShifts);
        if (blocked) await page.route("**/*.woff2", (route) => route.abort());
        const results = new Map<string, Measured & { links: number[][] }>();
        try {
          for (const path of pages()) {
            // oxlint-disable-next-line no-await-in-loop -- one tab, one page after another
            const measured = await settle(page, path, 0);
            // oxlint-disable-next-line no-await-in-loop
            const links = await page.evaluate(() =>
              [...document.querySelectorAll(".masthead a")].map((link) => {
                const box = link.getBoundingClientRect();
                return [box.x, box.width];
              }),
            );
            results.set(path, { ...measured, links });
          }
        } finally {
          await context.close();
        }
        return results;
      };
      const loaded = await frame(false);
      const standIn = await frame(true);
      for (const [path, withFont] of loaded) {
        const without = standIn.get(path)!;
        const pairs: [string, number[] | undefined, number[] | undefined][] = [
          ["header", withFont.header, without.header],
          ["nav", withFont.nav, without.nav],
          // The footer's left edge and width; how many lines its words take is the face's business.
          ["footer", withFont.footer?.slice(0, 2), without.footer?.slice(0, 2)],
          ["docs sidebar", withFont.docsNav, without.docsNav],
          ["article column", withFont.content, without.content],
          ["header links", withFont.links.flat(), without.links.flat()],
        ];
        for (const [name, a, b] of pairs) {
          expect(b?.length, `${name} on ${path}`).toBe(a?.length);
          // A box is the same either way; a word inside the nav may be a pixel or two wider in the stand-in.
          const slack = name === "header links" ? 2 : 1;
          a?.forEach((value, at) =>
            expect(
              Math.abs(value - b![at]!),
              `${name} on ${path} at ${width}px moves without the font`,
            ).toBeLessThanOrEqual(slack),
          );
        }
      }
    },
    120_000,
  );
});

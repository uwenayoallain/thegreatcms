/** Nothing shared moves: every page puts the masthead, main column and footer in one place, and none shifts as it loads. */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import type { Browser, BrowserType, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");

const RELEASES = readdirSync(join(ROOT, "content/changelog"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => `/changelog/${file.replace(/\.md$/, "")}/`);
const PAGES = ["/", "/changelog/", "/thanks/", "/404.html", ...RELEASES];
const LANDMARKS = {
  header: ".masthead",
  nav: ".masthead nav",
  main: "main",
  footer: ".footer",
};
const NAVIGATION = { from: "/thanks/", link: '.masthead a[href="/changelog/"]', to: "/changelog/" };
const WIDTHS = [375, 768, 1024, 1280, 1600];

type Box = { x: number; y: number; width: number; height: number };
type Shot = { cls: number; boxes: Record<string, Box> };
// A footer sits lower on a longer page and main is as tall as its page; nothing else may differ.
const COMPARED: Record<string, (keyof Box)[]> = {
  header: ["x", "y", "width", "height"],
  nav: ["x", "y", "width", "height"],
  main: ["x", "y", "width"],
  footer: ["x", "width", "height"],
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function loadChromium(): BrowserType | null {
  // The studio's browser tests own the Playwright install; this site borrows it.
  for (const from of [import.meta.url, join(ROOT, "../../apps/studio/package.json")]) {
    try {
      return (createRequire(from)("playwright") as typeof import("playwright")).chromium;
    } catch {}
  }
  return null;
}

async function launch(): Promise<Browser | null> {
  const chromium = loadChromium();
  // Real scrollbars: Playwright hides them by default, and with them the shift they cause.
  const options = { ignoreDefaultArgs: ["--hide-scrollbars"] };
  const browser = chromium
    ? await chromium
        .launch(options)
        .catch(() => chromium.launch({ ...options, channel: "chromium" }))
        .catch(() => chromium.launch({ ...options, channel: "chrome" }))
        .catch(() => null)
    : null;
  if (!browser) console.warn("No Chromium available: layout tests skipped.");
  return browser;
}

const browser = await launch();

function serveDist(): Server {
  return createServer((request, response) => {
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
}

let server: Server;
let origin: string;

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/changelog-nuxt before its tests.");
  }
  if (!browser) return;
  server = serveDist();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
});

/** A page at one width, counting every layout shift from its first byte. */
async function open(width: number, lateFonts: boolean): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width, height: 900 } });
  if (lateFonts) {
    await context.route(/\.woff2$/, (route) => setTimeout(() => void route.continue(), 400));
  }
  await context.addInitScript(() => {
    const record = globalThis as unknown as { layoutShift: number };
    record.layoutShift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
      }[]) {
        if (!entry.hadRecentInput) record.layoutShift += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  return context.newPage();
}

async function shot(page: Page): Promise<Shot> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate((landmarks) => {
    const boxes: Record<string, Box> = {};
    for (const [name, selector] of Object.entries(landmarks)) {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      const [x, y, width, height] = [rect.x, rect.y + scrollY, rect.width, rect.height].map(
        (value) => Math.round(value * 10) / 10,
      ) as [number, number, number, number];
      boxes[name] = { x, y, width, height };
    }
    return { cls: (globalThis as unknown as { layoutShift: number }).layoutShift, boxes };
  }, LANDMARKS);
}

const pick = (boxes: Record<string, Box>) =>
  Object.fromEntries(
    Object.entries(COMPARED).map(([name, keys]) => [
      name,
      Object.fromEntries(keys.map((key) => [key, boxes[name]![key]])),
    ]),
  );

describe.skipIf(!browser).each(WIDTHS)("at %ipx wide", (width) => {
  it.each([
    ["on time", false],
    ["late", true],
  ])(
    "puts every landmark in one place on every page, with fonts %s, and nothing shifts",
    async (_, late) => {
      const shots = await Promise.all(
        PAGES.map(async (path) => {
          const page = await open(width, late as boolean);
          await page.goto(origin + path);
          const result = await shot(page);
          await page.context().close();
          return [path, result] as const;
        }),
      );
      const [, first] = shots[0]!;
      for (const [path, { cls, boxes }] of shots) {
        expect(cls, `${path} shifted`).toBe(0);
        expect(pick(boxes), path).toEqual(pick(first.boxes));
      }
    },
  );

  it("keeps them in place through a navigation by link", async () => {
    const page = await open(width, false);
    await page.goto(origin + NAVIGATION.from);
    const before = await shot(page);
    await page.click(NAVIGATION.link);
    await page.waitForURL(origin + NAVIGATION.to);
    const after = await shot(page);
    await page.context().close();
    expect(after.cls).toBe(0);
    expect(pick(after.boxes)).toEqual(pick(before.boxes));
  });
});

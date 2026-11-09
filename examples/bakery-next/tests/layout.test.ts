/** Nothing shared moves: every page puts the masthead, main column and footer in one place, and none shifts as it loads. */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import type { Browser, BrowserType, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");

const PAGES = ["/", "/menu/", "/thanks/", "/404.html"];
const LANDMARKS = {
  header: "body > header",
  nav: "header nav",
  main: "main",
  footer: "body > footer",
};
const NAVIGATION = { from: "/thanks/", link: 'header nav a[href="/menu/"]', to: "/menu/" };
const WIDTHS = [375, 768, 1024, 1280, 1600];
// A late font reflows at any width it reflows at all; a phone and a desktop are enough to catch it.
const LATE_FONT_WIDTHS = new Set([375, 1280]);
// Every page is loaded cold, one at a time, while `pnpm check` runs everything else beside it.
const BUDGET = 90_000;

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

/** The built site, with every font answered `fontDelay` milliseconds late. */
function serveDist(fontDelay: number): Server {
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
    const send = () => {
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(response);
    };
    if (fontDelay && file.endsWith(".woff2")) setTimeout(send, fontDelay);
    else send();
  });
}

const servers: Server[] = [];
const origins = { onTime: "", late: "" };

async function listen(fontDelay: number): Promise<string> {
  const server = serveDist(fontDelay);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/bakery-next before its tests.");
  }
  if (!browser) return;
  [origins.onTime, origins.late] = await Promise.all([listen(0), listen(400)]);
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A page at one width, counting every layout shift from its first byte. */
async function open(width: number): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width, height: 900 } });
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
  await page.waitForLoadState("load");
  // Whatever arrives after load, fonts and anything hydrating, has a moment to move things.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
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

async function visit(width: number, url: string): Promise<Shot> {
  const page = await open(width);
  await page.goto(url);
  const result = await shot(page);
  await page.context().close();
  return result;
}

const pick = (boxes: Record<string, Box>) =>
  Object.fromEntries(
    Object.entries(COMPARED).map(([name, keys]) => [
      name,
      Object.fromEntries(keys.map((key) => [key, boxes[name]![key]])),
    ]),
  );

describe.skipIf(!browser).each(WIDTHS)("at %ipx wide", (width) => {
  it.each(
    LATE_FONT_WIDTHS.has(width)
      ? ([
          ["on time", "onTime"],
          ["late", "late"],
        ] as const)
      : ([["on time", "onTime"]] as const),
  )(
    "puts every landmark in one place on every page, with fonts %s, and nothing shifts",
    async (_, late) => {
      const shots: [string, Shot][] = [];
      // One page at a time: Chromium can treat a page that is not in front as hidden, and a
      // hidden page never paints, so it would neither shift nor finish its frame.
      for (const path of PAGES) {
        // oxlint-disable-next-line no-await-in-loop
        shots.push([path, await visit(width, origins[late] + path)]);
      }
      const [, first] = shots[0]!;
      for (const [path, { cls, boxes }] of shots) {
        expect(cls, `${path} shifted`).toBe(0);
        expect(pick(boxes), path).toEqual(pick(first.boxes));
      }
    },
    BUDGET,
  );

  it(
    "keeps them in place through a navigation by link",
    async () => {
      const page = await open(width);
      await page.goto(origins.onTime + NAVIGATION.from);
      const before = await shot(page);
      await page.click(NAVIGATION.link);
      await page.waitForURL(origins.onTime + NAVIGATION.to);
      const after = await shot(page);
      await page.context().close();
      expect(after.cls).toBe(0);
      expect(pick(after.boxes)).toEqual(pick(before.boxes));
    },
    BUDGET,
  );
});

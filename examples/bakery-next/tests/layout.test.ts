/** Nothing shared moves: every page puts the masthead, main column and footer in one place, and none shifts as it loads. All of it in a browser, where the pages run no script. */

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

async function visit(width: number, url: string, withoutFonts = false): Promise<Shot> {
  const page = await open(width);
  if (withoutFonts) await page.route("**/*.woff2", (route) => route.abort());
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

describe.skipIf(!browser)("whichever face is drawn", () => {
  // The face is optional: a visit may be drawn in it or in its stand-in, and the frame must not care which.
  it.each([375, 1280])(
    "at %ipx every landmark sits in the same place with the web font and without it",
    async (width) => {
      for (const path of PAGES) {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time, in front, so it paints
        const loaded = await visit(width, origins.onTime + path);
        // oxlint-disable-next-line no-await-in-loop
        const standIn = await visit(width, origins.onTime + path, true);
        expect(standIn.cls, `${path} shifted without its font`).toBe(0);
        for (const [name, keys] of Object.entries(COMPARED)) {
          for (const key of keys) {
            // How many lines the footer's words take is the face's business; where the frame sits is not.
            if (name === "footer" && key === "height") continue;
            // Within a pixel: two faces round to different sub-pixel sizes.
            expect(
              Math.abs(loaded.boxes[name]![key] - standIn.boxes[name]![key]),
              `${path} ${name}.${key} at ${width}px moves without the font`,
            ).toBeLessThanOrEqual(2);
          }
        }
      }
    },
    BUDGET,
  );

  // 320px is the narrowest phone still in use, and what a desktop window zoomed to 400% lays out as.
  it(
    "at 320px no page scrolls sideways",
    async () => {
      const page = await open(320);
      for (const path of PAGES) {
        // oxlint-disable-next-line no-await-in-loop -- one tab, one page after another
        await page.goto(origins.onTime + path, { waitUntil: "load" });
        // A phone draws its scrollbar over the page; this browser takes room for it, so give that room back.
        // oxlint-disable-next-line no-await-in-loop
        const bar = await page.evaluate(() => innerWidth - document.documentElement.clientWidth);
        // oxlint-disable-next-line no-await-in-loop
        await page.setViewportSize({ width: 320 + bar, height: 900 });
        // oxlint-disable-next-line no-await-in-loop
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
        // oxlint-disable-next-line no-await-in-loop
        await page.setViewportSize({ width: 320, height: 900 });
      }
      await page.context().close();
    },
    BUDGET,
  );
});

describe.skipIf(!browser)("with no script on the page", () => {
  it(
    "loads every page without asking for a script, or for anything that is missing",
    async () => {
      const page = await open(1280);
      const asked: string[] = [];
      page.on("response", (response) => {
        const kind = response.request().resourceType();
        if (kind === "script" || response.status() >= 400)
          asked.push(`${kind} ${response.status()} ${response.url()}`);
      });
      for (const path of PAGES) {
        // oxlint-disable-next-line no-await-in-loop -- one tab, one page after another
        await page.goto(origins.onTime + path, { waitUntil: "load" });
        // oxlint-disable-next-line no-await-in-loop
        expect(await page.locator("script:not([type='application/ld+json'])").count()).toBe(0);
      }
      await page.context().close();
      expect(asked).toEqual([]);
    },
    BUDGET,
  );

  it(
    "still runs its motion from the stylesheet: scroll-driven effects, and a transition between pages",
    async () => {
      const page = await open(1280);
      await page.addInitScript(() => {
        addEventListener("pagereveal", (event) => {
          const reveal = event as Event & { viewTransition: unknown };
          (globalThis as unknown as { crossed: boolean }).crossed = reveal.viewTransition !== null;
        });
      });
      await page.goto(origins.onTime + "/");
      const motion = await page.evaluate(() => {
        const timeline = (selector: string) =>
          getComputedStyle(document.querySelector(selector)!).animationTimeline;
        return {
          scrollDriven: CSS.supports("animation-timeline: view()"),
          card: timeline(".card"),
          stamp: timeline(".stamp text"),
          masthead: getComputedStyle(document.querySelector("body > header")!).viewTransitionName,
        };
      });
      expect(motion.masthead).toBe("masthead");
      // A browser without scroll timelines shows the page still, which the stylesheet allows for.
      if (motion.scrollDriven) {
        expect(motion.card).toContain("view(");
        expect(motion.stamp).toContain("scroll(");
      }
      await page.click('header nav a[href="/menu/"]');
      await page.waitForURL(origins.onTime + "/menu/");
      await page.waitForFunction(() => "crossed" in globalThis);
      const crossed = await page.evaluate(
        () => (globalThis as unknown as { crossed: boolean }).crossed,
      );
      expect(crossed).toBe(true);
      await page.context().close();
    },
    BUDGET,
  );

  it(
    "holds an order back until the browser is satisfied, then posts it as a form and lands on the thank-you page",
    async () => {
      const page = await open(1280);
      // Smooth scrolling to each field is motion this test has no use for.
      await page.emulateMedia({ reducedMotion: "reduce" });
      const posted: { method: string; type?: string; body: string }[] = [];
      await page.route(/\/f\/[\w-]+\/order$/, async (route) => {
        const request = route.request();
        posted.push({
          method: request.method(),
          type: request.headers()["content-type"],
          body: request.postData() ?? "",
        });
        await route.fulfill({ status: 303, headers: { location: `${origins.onTime}/thanks/` } });
      });
      await page.goto(origins.onTime + "/");
      await page.click("form.form button[type=submit]");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("name");
      expect(await page.locator("form.form :invalid").count()).toBe(3);

      await page.fill("#name", "Ada");
      await page.fill("#email", "not an address");
      await page.fill("#pickup", "2030-01-02");
      await page.click("form.form button[type=submit]");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("email");
      expect(posted).toEqual([]);

      await page.fill("#email", "ada@example.com");
      const boxes = page.locator('form.form input[name="items"]');
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      await page.click("form.form button[type=submit]");
      await page.waitForURL(origins.onTime + "/thanks/");

      expect(posted).toHaveLength(1);
      expect(posted[0]!.method).toBe("POST");
      expect(posted[0]!.type).toBe("application/x-www-form-urlencoded");
      const fields = new URLSearchParams(posted[0]!.body);
      expect(fields.get("name")).toBe("Ada");
      expect(fields.getAll("items")).toHaveLength(2);
      expect(fields.get("_redirect")).toBe("/thanks/");
      expect(await page.locator("h1").textContent()).toMatch(/Thank you/);
      await page.context().close();
    },
    BUDGET,
  );

  it(
    "shows the 404 page, whose way back to the menu works",
    async () => {
      const page = await open(1280);
      await page.goto(origins.onTime + "/404.html");
      expect(await page.locator("h1").textContent()).toMatch(/sold out/);
      await page.click("main a.button");
      await page.waitForURL(origins.onTime + "/menu/");
      expect(await page.locator(".item").count()).toBeGreaterThan(0);
      await page.context().close();
    },
    BUDGET,
  );
});

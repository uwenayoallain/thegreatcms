/** Moving between screens moves nothing they share, and nothing jumps once a screen has loaded. */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createSessionCookie, editorStamp, flashCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";
import { GitAccess } from "../src/git-access.js";
import { GitHub } from "../src/github.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const SECRET = "layout-test-secret";
const PASSWORD = "layout-test-password";

/** With real scrollbars, which take room on a desktop and so can move a page sideways. */
async function launch(): Promise<Browser | null> {
  const { chromium } = await import("playwright");
  const options = { ignoreDefaultArgs: ["--hide-scrollbars"] };
  return chromium
    .launch(options)
    .catch(() => chromium.launch({ ...options, channel: "chromium" }))
    .catch(() => chromium.launch({ ...options, channel: "chrome" }))
    .catch(() => null);
}

const browser = await launch();

const SCHEMA = `version: 1
blocks:
  feature:
    label: Feature
    fields:
      heading: { type: text, required: true }
      image: { type: image }
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true, label: Heading }
      body: { type: richtext, label: Body }
    default:
      heading: Welcome
  site.meta:
    label: Site details
    fields:
      title: { type: text, required: true, label: Title }
      description: { type: text, label: Description }
    default:
      title: Example
  home.sections:
    label: Home sections
    type: blocks
    allow: [feature]
    default:
      - { _type: feature, heading: First feature }
      - { _type: feature, heading: Second feature }
collections:
  pages:
    label: Pages
    entryLabel: page
    path: content/pages
    format: json
    slug: title
    fields:
      title: { type: text, required: true }
      sections: { type: blocks, allow: [feature] }
`;

const LONG = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1} of copy.</p>`).join("");

/** Every kind of screen, and the site whose sidebar it shows. */
const SCREENS: Array<{
  name: string;
  path: string;
  site?: string;
  signedOut?: boolean;
  /** Signed in with GitHub, as someone who can open no site. */
  github?: boolean;
}> = [
  { name: "sites", path: "/" },
  { name: "connect", path: "/sites/new" },
  { name: "set up", path: "/sites/setup?path=SITES_ROOT/bare" },
  { name: "git access", path: "/git-access" },
  { name: "inbox", path: "/inbox" },
  { name: "editors", path: "/editors" },
  { name: "site", path: "/sites/site-1", site: "site-1" },
  { name: "settings", path: "/sites/site-1/settings", site: "site-1" },
  { name: "region plain", path: "/sites/site-1/regions/site.meta", site: "site-1" },
  { name: "region rich", path: "/sites/site-1/regions/home.hero", site: "site-1" },
  { name: "blocks", path: "/sites/site-1/regions/home.sections", site: "site-1" },
  { name: "collection", path: "/sites/site-1/collections/pages", site: "site-1" },
  { name: "entry", path: "/sites/site-1/collections/pages/about", site: "site-1" },
  { name: "new entry", path: "/sites/site-1/collections/pages/new", site: "site-1" },
  { name: "history", path: "/sites/site-1/regions/home.hero/history", site: "site-1" },
  { name: "search", path: "/sites/site-1/search?q=e", site: "site-1" },
  { name: "region down", path: "/sites/site-2/regions/home.hero", site: "site-2" },
  { name: "sign in", path: "/sign-in", signedOut: true },
  { name: "no sites", path: "/", signedOut: true, github: true },
];

const WIDTHS = [375, 768, 1024, 1280, 1600];

/**
 * What every screen with the shell shares, and which edges must match between which screens: all
 * of them, those of one site, or those with a site's map (on a phone, a row of its own).
 */
type Group = "all" | "site" | "map";
const ALL: Array<keyof Box> = ["x", "y", "width", "height"];
const LANDMARKS: Array<{
  name: string;
  selector: string;
  checks: Array<[Array<keyof Box>, Group]>;
}> = [
  {
    name: "sidebar",
    selector: ".sidebar",
    checks: [
      [["x", "y", "width"], "all"],
      [["height"], "map"],
    ],
  },
  { name: "brand", selector: ".sidebar .brand", checks: [[ALL, "all"]] },
  { name: "sections", selector: '.sidebar nav[aria-label="Sections"]', checks: [[ALL, "all"]] },
  { name: "account", selector: ".sidebar .sign-out", checks: [[ALL, "all"]] },
  { name: "theme", selector: ".sidebar > .theme-switch", checks: [[ALL, "all"]] },
  { name: "site nav", selector: ".sidebar .site-nav", checks: [[ALL, "site"]] },
  { name: "search box", selector: ".sidebar .nav-search", checks: [[ALL, "site"]] },
  {
    name: "crumbs",
    selector: ".crumbs",
    checks: [
      [["x", "width", "height"], "all"],
      [["y"], "map"],
    ],
  },
  {
    name: "content",
    selector: ".content",
    checks: [
      [["x", "width"], "all"],
      [["y"], "map"],
    ],
  },
  ...[
    ["main", "main"],
    ["page head", "main > .page-head"],
    ["heading", "main > .page-head h1"],
  ].map(([name, selector]) => ({
    name: name!,
    selector: selector!,
    checks: [
      [["x"], "all"],
      [["y"], "map"],
    ] as Array<[Array<keyof Box>, Group]>,
  })),
];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Measure {
  cls: number;
  shifts: Array<{ value: number; sources: string[] }>;
  boxes: Record<string, Box | null>;
  font: string;
  notice: string;
}

let server: ReturnType<typeof serve>;
let devServer: ReturnType<typeof createServer>;
let origin: string;
let sitesRoot: string;
let githubCookie: string;
const roots: string[] = [];

function makeSiteFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "greatcms-layout-"));
  roots.push(root);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(".cms/schema.yaml", SCHEMA);
  write(".cms/config.yaml", "version: 1\n");
  write(
    "content/cms/home.hero.json",
    JSON.stringify({ heading: "Welcome", body: { html: LONG } }, null, 2),
  );
  write(
    "content/pages/about.json",
    JSON.stringify({ title: "About", sections: [{ _type: "feature", heading: "Who we are" }] }),
  );
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);
  write("content/cms/home.hero.json", JSON.stringify({ heading: "Hello", body: { html: LONG } }));
  git(["commit", "-qam", "Edit the hero"]);
  return root;
}

beforeAll(async () => {
  if (!browser) return;
  devServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Site</title><h1>Welcome</h1>");
  });
  await new Promise<void>((resolve) => devServer.listen(0, "127.0.0.1", resolve));
  const devAddress = devServer.address();
  const devOrigin = `http://127.0.0.1:${typeof devAddress === "object" && devAddress ? devAddress.port : 0}`;

  const store = new Store(":memory:");
  store.addSite({
    id: "site-1",
    name: "Example",
    path: makeSiteFolder(),
    devUrl: devOrigin,
    createdAt: "2026-08-16",
  });
  // Port 9 is discard: nothing answers, so this site's preview says its server is not running.
  store.addSite({
    id: "site-2",
    name: "Stopped",
    path: makeSiteFolder(),
    devUrl: "http://127.0.0.1:9",
    createdAt: "2026-08-16",
  });
  store.addSubmission({
    siteId: "site-1",
    form: "contact",
    data: { name: "Ada", message: "Hello there" },
    spamScore: 0,
    spamReasons: [],
  });
  // A sites folder with one site ready to connect and one to set up, as the connect page lists them.
  sitesRoot = mkdtempSync(join(tmpdir(), "greatcms-layout-sites-"));
  roots.push(sitesRoot);
  mkdirSync(join(sitesRoot, "ready", ".cms"), { recursive: true });
  writeFileSync(join(sitesRoot, "ready", ".cms", "schema.yaml"), SCHEMA);
  mkdirSync(join(sitesRoot, "bare"));
  // A GitHub App that can sign people in and is installed nowhere, so the sign-in screen has its
  // GitHub button and someone who signs in with it has no site to open.
  const appFile = join(sitesRoot, ".github-app.json");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(
    appFile,
    JSON.stringify({
      id: 7,
      slug: "greatcms-layout",
      clientId: "Iv1.layout",
      pem: privateKey,
      htmlUrl: "https://github.com/apps/greatcms-layout",
      owner: "acme",
      ownerType: "Organization",
      clientSecret: "0123456789abcdef0123456789abcdef01234567",
    }),
  );
  const person = store.saveGithubPerson({ id: 303, login: "visitor", name: "A Visitor" });
  const key = sessionKey(SECRET, PASSWORD);
  githubCookie = createSessionCookie(key, {
    actor: `github:${person.id}`,
    stamp: editorStamp(key, `${person.salt}:7`),
  }).split(";")[0]!;
  const app = createApp({
    store,
    password: PASSWORD,
    secret: SECRET,
    sitesRoot,
    gitAccess: new GitAccess(join(sitesRoot, ".git-access"), {}),
    github: new GitHub(appFile, undefined, async () => new Response("[]")),
  });
  server = serve({ fetch: app.fetch, port: 0, createServer });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await browser?.close();
  server?.close();
  devServer?.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function newContext(
  width: number,
  options: { signedOut?: boolean; js?: boolean; cookies?: Record<string, string> } = {},
) {
  const context = await browser!.newContext({
    viewport: { width, height: 900 },
    javaScriptEnabled: options.js ?? true,
  });
  const cookies = { ...options.cookies };
  if (!options.signedOut) {
    const [name, value] = createSessionCookie(sessionKey(SECRET, PASSWORD))
      .split(";")[0]!
      .split("=") as [string, string];
    cookies[name] = value;
  }
  await context.addCookies(
    Object.entries(cookies).map(([name, value]) => ({ name, value, url: origin })),
  );
  return context;
}

/** Loads a screen as a first visit would, with fonts and scripts arriving late, and measures it. */
async function measure(
  screen: (typeof SCREENS)[number],
  width: number,
  extra: Record<string, string> = {},
): Promise<Measure> {
  const { path, signedOut } = screen;
  const [cookieName, cookieValue] = githubCookie.split("=") as [string, string];
  const context = await newContext(width, {
    signedOut,
    cookies: { ...extra, ...(screen.github ? { [cookieName]: cookieValue } : {}) },
  });
  // Late fonts and bundles are what make a page jump; routing also turns the HTTP cache off.
  await context.route(/\/assets\/.*\.(woff2|js)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  // Layout shifts reach only an observer, never the timeline, so one listens from the first byte.
  await context.addInitScript(() => {
    const shifts: Array<{ value: number; sources: string[] }> = [];
    (window as unknown as { shifts: typeof shifts }).shifts = shifts;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Array<{
        value: number;
        hadRecentInput: boolean;
        sources?: Array<{ node?: Node }>;
      }>) {
        if (entry.hadRecentInput) continue;
        shifts.push({
          value: entry.value,
          sources: (entry.sources ?? []).map((source) => {
            const node = source.node as Element | undefined;
            if (!node || !("tagName" in node)) return node?.nodeName ?? "?";
            const classes = typeof node.className === "string" ? node.className.trim() : "";
            return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${classes ? `.${classes.split(/\s+/).join(".")}` : ""}`;
          }),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const page: Page = await context.newPage();
  try {
    await page.goto(origin + path.replace("SITES_ROOT", encodeURIComponent(sitesRoot)), {
      waitUntil: "load",
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const shots = process.env.GREATCMS_TEST_SCREENSHOTS;
    if (shots)
      await page.screenshot({
        path: join(shots, `${width}-${screen.name.replace(/ /g, "-")}.png`),
      });
    return await page.evaluate((landmarks) => {
      const { shifts } = window as unknown as {
        shifts: Array<{ value: number; sources: string[] }>;
      };
      const boxes: Record<string, { x: number; y: number; width: number; height: number } | null> =
        {};
      for (const { name, selector } of landmarks) {
        const element = document.querySelector(selector);
        if (!element) {
          boxes[name] = null;
          continue;
        }
        const rect = element.getBoundingClientRect();
        const [x, y, w, h] = [rect.x, rect.y, rect.width, rect.height].map(
          (n) => Math.round(n * 10) / 10,
        );
        boxes[name] = { x: x!, y: y!, width: w!, height: h! };
      }
      const h1 = document.querySelector("main h1");
      return {
        cls: shifts.reduce((sum, shift) => sum + shift.value, 0),
        shifts,
        boxes,
        font: h1 ? getComputedStyle(h1).fontSize : "",
        notice: document.querySelector("main > .flash")?.textContent?.trim() ?? "",
      };
    }, LANDMARKS);
  } finally {
    await context.close();
  }
}

/** Every landmark that differs from where the first screen showing it put it. */
function mismatches(results: Map<string, Measure>): string[] {
  const problems: string[] = [];
  const signedIn = SCREENS.filter((screen) => !screen.signedOut);
  for (const landmark of LANDMARKS) {
    for (const [fields, group] of landmark.checks) {
      const reference = new Map<string, { screen: string; box: Box }>();
      for (const screen of signedIn) {
        const box = results.get(screen.name)?.boxes[landmark.name];
        if (!box) continue;
        const key =
          group === "all" ? "" : group === "site" ? (screen.site ?? "") : String(!!screen.site);
        const first = reference.get(key);
        if (!first) {
          reference.set(key, { screen: screen.name, box });
          continue;
        }
        for (const field of fields) {
          if (box[field] !== first.box[field]) {
            problems.push(
              `${landmark.name}.${field}: ${screen.name} ${box[field]}, ${first.screen} ${first.box[field]}`,
            );
          }
        }
      }
    }
  }
  const sizes = new Set(signedIn.map((screen) => results.get(screen.name)?.font));
  if (sizes.size > 1) problems.push(`heading sizes differ: ${[...sizes].join(", ")}`);
  return problems;
}

/** Where everything on the sign-in screen is, and how many lines its tagline runs to. */
const places = (page: Page) =>
  page.evaluate(() => {
    const found: Record<string, string> = {};
    let index = 0;
    for (const element of document.querySelectorAll("body *")) {
      // The letters inside the wordmark are drawn, not laid out, and are still lifting.
      if (element.closest("svg") && element.tagName !== "svg") continue;
      const rect = element.getBoundingClientRect();
      const name = `${index++} ${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}`;
      found[name] = `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.height)}`;
    }
    found.page = String(document.documentElement.scrollHeight);
    // Its room is held, so its lines are counted too: a third would spill out of it unseen.
    const words = document.createRange();
    words.selectNodeContents(document.querySelector(".sign-in-word p")!);
    const tops = [...words.getClientRects()].map((rect) => Math.round(rect.y));
    found.lines = String(new Set(tops).size);
    return found;
  });

describe.skipIf(!browser)("layout stability", () => {
  const report: Record<number, Record<string, Measure>> = {};

  afterAll(() => {
    const file = process.env.GREATCMS_LAYOUT_REPORT;
    if (file) writeFileSync(file, JSON.stringify(report, null, 2));
  });

  it.each(WIDTHS)("at %ipx, no screen shifts and shared landmarks hold still", async (width) => {
    const results = new Map<string, Measure>();
    for (const screen of SCREENS) {
      // One at a time: pages loading side by side would delay each other's fonts and scripts unevenly.
      // oxlint-disable-next-line no-await-in-loop
      results.set(screen.name, await measure(screen, width));
    }
    report[width] = Object.fromEntries(results);

    const shifted = [...results]
      // Below this a shift is a fraction of a pixel of font rounding, which differs by machine.
      .filter(([, result]) => result.cls > 0.0005)
      .map(([name, result]) => `${name}: ${result.cls.toFixed(4)}`);
    expect.soft(shifted).toEqual([]);
    expect.soft(mismatches(results)).toEqual([]);
  });

  it.each([375, 1280])(
    "at %ipx, a notice left by an action is on the page from its first paint",
    async (width) => {
      const [name, value] = flashCookie(sessionKey(SECRET, PASSWORD), "studio", {
        kind: "success",
        message: "Settings saved.",
      })
        .split(";")[0]!
        .split("=") as [string, string];
      const result = await measure({ name: "site with a notice", path: "/sites/site-1" }, width, {
        [name]: value,
      });
      expect(result.notice).toBe("Settings saved.");
      expect(result.shifts).toEqual([]);
    },
  );

  it("lays the sign-in screen out the same before and after its font arrives, at any width", async () => {
    const pages: Page[] = [];
    const contexts = await Promise.all(
      [false, true].map(() => newContext(1280, { signedOut: true })),
    );
    try {
      // One browser never gets the font, the other has it: what a late font moves is their difference.
      await contexts[0]!.route(/\.woff2/, (route) => route.abort());
      for (const context of contexts) {
        // oxlint-disable-next-line no-await-in-loop
        const page = await context.newPage();
        // oxlint-disable-next-line no-await-in-loop
        await page.goto(`${origin}/sign-in`, { waitUntil: "load" });
        // oxlint-disable-next-line no-await-in-loop
        await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
        pages.push(page);
      }
      const faces = await Promise.all(
        pages.map((page) =>
          page.evaluate(() => document.fonts.check('700 16px "Space Grotesk"', "Sign in")),
        ),
      );
      expect(faces).toEqual([false, true]);
      const moved: string[] = [];
      for (let width = 300; width <= 1700; width += 4) {
        // oxlint-disable-next-line no-await-in-loop
        await Promise.all(pages.map((page) => page.setViewportSize({ width, height: 900 })));
        // oxlint-disable-next-line no-await-in-loop
        const [without, withFont] = (await Promise.all(pages.map(places))) as [
          Record<string, string>,
          Record<string, string>,
        ];
        if (withFont.lines !== "2")
          moved.push(`${width}px: ${withFont.lines} lines under the wordmark`);
        for (const [name, place] of Object.entries(without)) {
          if (withFont[name] !== place)
            moved.push(`${width}px ${name}: ${place} -> ${withFont[name]}`);
        }
      }
      expect(moved.slice(0, 12)).toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });

  it.each([375, 1280])(
    "at %ipx, gives the GitHub button the width of the password form's, with no script",
    async (width) => {
      const context = await newContext(width, { signedOut: true, js: false });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/sign-in`);
        const github = await page.locator(".sign-in-github a").boundingBox();
        await expect(page.locator("input[type=password]").count()).resolves.toBe(0);
        const other = await page.locator(".sign-in-other a").boundingBox();
        expect(github && other).toBeTruthy();
        expect(github!.height).toBeGreaterThanOrEqual(44);
        expect(github!.y + github!.height).toBeLessThan(other!.y);
        await page.goto(`${origin}/sign-in?with=password`);
        const submit = await page.locator("form[action='/sign-in'] button").boundingBox();
        expect(github!.x).toBe(submit!.x);
        expect(github!.width).toBe(submit!.width);
        await page.goto(`${origin}/sign-in`);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        // A link, so the trip to GitHub needs no form-action beyond this studio.
        await expect(page.locator(".sign-in-github a").getAttribute("href")).resolves.toBe(
          "/sign-in/github",
        );
      } finally {
        await context.close();
      }
    },
  );

  it.each([320, 375, 600])(
    "at %ipx, runs the sign-in screen's dark panel to both edges of the window",
    async (width) => {
      const context = await newContext(width, { signedOut: true });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/sign-in`);
        const found = await page.evaluate(() => {
          const art = document.querySelector(".sign-in-art")!.getBoundingClientRect();
          const root = document.documentElement;
          return {
            left: art.left,
            right: art.right,
            window: window.innerWidth,
            // A page that scrolls has a scrollbar there, which is the edge.
            edge: root.scrollHeight > root.clientHeight ? root.clientWidth : window.innerWidth,
          };
        });
        expect(found.left).toBe(0);
        expect(found.right).toBe(found.edge);
        expect(found.window).toBe(width);
      } finally {
        await context.close();
      }
    },
  );

  it("draws every screen at the widths the panes were dragged to, before any script runs", async () => {
    const cookies = { greatcms_sidebar: "320", greatcms_live: "560" };
    const context = await newContext(1600, { js: false, cookies });
    try {
      const widths = await Promise.all(
        ["/", "/sites/site-1", "/sites/site-1/regions/home.hero"].map(async (path) => {
          const page = await context.newPage();
          await page.goto(origin + path);
          const [sidebar, live] = await Promise.all(
            [".sidebar", ".live"].map(async (selector) =>
              (await page.locator(selector).count()) > 0
                ? (await page.locator(selector).boundingBox())?.width
                : undefined,
            ),
          );
          return { path, sidebar, live };
        }),
      );
      expect(widths).toEqual([
        { path: "/", sidebar: 320, live: undefined },
        { path: "/sites/site-1", sidebar: 320, live: undefined },
        { path: "/sites/site-1/regions/home.hero", sidebar: 320, live: 560 },
      ]);
    } finally {
      await context.close();
    }
  });

  it("puts everything on the sign-in screen in the same place with the web font and without it", async () => {
    const boxes = async (width: number, blocked: boolean) => {
      const context = await newContext(width, { signedOut: true, js: false });
      if (blocked) await context.route(/\.woff2/, (route) => route.abort());
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/sign-in`, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        return await page.evaluate(() =>
          [...document.querySelectorAll("body *")].map((element) => {
            const box = element.getBoundingClientRect();
            return [element.tagName, box.x, box.y, box.width, box.height] as const;
          }),
        );
      } finally {
        await context.close();
      }
    };
    for (const width of [320, 375, 1024, 1600]) {
      // oxlint-disable-next-line no-await-in-loop -- one width at a time keeps the browser light
      const [drawn, standIn] = await Promise.all([boxes(width, false), boxes(width, true)]);
      const moved = drawn.flatMap((box, index) => {
        const other = standIn[index];
        const apart = other
          ? Math.max(...[1, 2, 3, 4].map((at) => Math.abs(+box[at]! - +other[at]!)))
          : 99;
        // Two pixels is what text rounding differs by between machines' font renderers.
        return apart > 2 ? [`${box[0]} at ${width}px moves ${apart.toFixed(1)}px`] : [];
      });
      expect(moved).toEqual([]);
    }
  });
});

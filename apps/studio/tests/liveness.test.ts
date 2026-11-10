/** Whether a site's dev server is running, as the studio's screens report it. */

import { JSDOM } from "jsdom";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Liveness } from "../src/liveness.js";
import type { Site } from "../src/db.js";
import { type Fixture, get, makeSite } from "./site.js";

const SCHEMA = "version: 1\nregions:\n  home.hero:\n    fields:\n      heading: { type: text }\n";

const site = (devUrl: string | null, id = "s") => ({ id, devUrl }) as unknown as Site;

const listen = () =>
  new Promise<Server>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

/** A port something listens on, and one nothing does. */
async function ports(): Promise<{ open: number; closed: number; server: Server }> {
  const server = await listen();
  const spare = await listen();
  const closed = (spare.address() as { port: number }).port;
  await new Promise((resolve) => spare.close(resolve));
  return { open: (server.address() as { port: number }).port, closed, server };
}

let fixture: Fixture | undefined;
let server: Server | undefined;
afterEach(() => {
  fixture?.cleanup();
  server?.close();
});

describe("the dev server check", () => {
  it("is running when something accepts a connection, and not when nothing does", async () => {
    const found = await ports();
    server = found.server;
    const liveness = new Liveness();

    expect(await liveness.running(site(`http://127.0.0.1:${found.open}`))).toBe(true);
    expect(await liveness.running(site(`http://127.0.0.1:${found.closed}`, "t"))).toBe(false);
  });

  it("has nothing to say about a site without a dev server", async () => {
    expect(await new Liveness().running(site(null))).toBeNull();
  });

  it("asks where the studio reaches the server, not where a browser does", async () => {
    const found = await ports();
    server = found.server;
    const liveness = new Liveness(new Map([["s", `http://127.0.0.1:${found.open}`]]));

    expect(await liveness.running(site("https://preview.invalid"))).toBe(true);
  });
});

describe("the screens", () => {
  it("say a site's dev server is not running, on the list and on the site", async () => {
    const { closed, server: listening } = await ports();
    server = listening;
    fixture = makeSite({ schema: SCHEMA, devUrl: `http://127.0.0.1:${closed}` });

    expect(await (await get(fixture, "/")).text()).toContain("Dev server not running");
    // Nothing to open while it is down, so there is no link to a page that will not load.
    expect(await (await get(fixture, "/")).text()).not.toContain("open-site");
    const downOverview = await (await get(fixture, "/sites/site-1")).text();
    expect(downOverview).toContain("Not running");
    expect(downOverview).not.toContain("open-site");
    const editor = await (await get(fixture, "/sites/site-1/regions/home.hero")).text();
    expect(editor).toContain("is not running.");
  });

  it("say it is running when it is", async () => {
    const { open, server: listening } = await ports();
    server = listening;
    fixture = makeSite({ schema: SCHEMA, devUrl: `http://127.0.0.1:${open}` });

    const list = new JSDOM(await (await get(fixture, "/")).text()).window.document;
    // Straight from the list of sites: a link to the running site, in a new tab.
    const link = list.querySelector<HTMLAnchorElement>("a.open-site");
    expect(link?.getAttribute("href")).toBe(`http://127.0.0.1:${open}`);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener");
    expect(link?.textContent?.replace(/\s+/g, " ")).toContain(`Open site at 127.0.0.1:${open}`);
    const overview = new JSDOM(await (await get(fixture, "/sites/site-1")).text()).window.document;
    const overviewLink = overview.querySelector<HTMLAnchorElement>("a.open-site");
    expect(overviewLink?.getAttribute("href")).toBe(`http://127.0.0.1:${open}`);
    expect(overviewLink?.target).toBe("_blank");
    expect(overviewLink?.rel).toBe("noopener");
    expect(await (await get(fixture, "/sites/site-1/regions/home.hero")).text()).not.toContain(
      "live-down",
    );
  });
});

describe("a site the preview service runs, asked through the proxy in front of it", () => {
  /** A proxy that is always up, with a preview service behind it that may not be. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the tests that use it
  const proxy = (answer: (host: string, path: string) => number) =>
    new Promise<{ url: string; asked: string[]; close: () => void }>((resolve) => {
      const asked: string[] = [];
      const listening = createHttpServer((request, response) => {
        asked.push(`${request.headers.host} ${request.url}`);
        response.writeHead(answer(request.headers.host ?? "", request.url ?? "")).end();
      });
      listening.listen(0, "127.0.0.1", () =>
        resolve({
          url: `http://127.0.0.1:${(listening.address() as { port: number }).port}`,
          asked,
          close: () => listening.close(),
        }),
      );
    });
  const shop = site("https://shop-preview.example.com", "shop");

  it("is up when the service answers for that site, without starting its dev server", async () => {
    const front = await proxy(() => 200);
    try {
      expect(await new Liveness(new Map(), () => front.url).all([shop])).toEqual(
        new Map([["shop", true]]),
      );
      expect(front.asked).toEqual(["shop-preview.example.com /__greatcms/preview"]);
    } finally {
      front.close();
    }
  });

  it("is down when the proxy is up and the service behind it is not", async () => {
    const front = await proxy(() => 502);
    try {
      expect(await new Liveness(new Map(), () => front.url).running(shop)).toBe(false);
    } finally {
      front.close();
    }
  });

  it("is down for a site the service does not know, and up for one it does", async () => {
    const front = await proxy((host) => (host === "shop-preview.example.com" ? 200 : 404));
    try {
      const liveness = new Liveness(new Map(), () => front.url);
      const other = site("https://other-preview.example.com", "other");
      expect(await liveness.all([shop, other])).toEqual(
        new Map([
          ["shop", true],
          ["other", false],
        ]),
      );
    } finally {
      front.close();
    }
  });

  it("is down when nothing is listening at all", async () => {
    const found = await ports();
    server = found.server;
    const liveness = new Liveness(new Map(), () => `http://127.0.0.1:${found.closed}`);
    expect(await liveness.running(shop)).toBe(false);
  });
});

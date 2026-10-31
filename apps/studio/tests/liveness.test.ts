/** Whether a site's dev server is running, as the studio's screens report it. */

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
    expect(await (await get(fixture, "/sites/site-1")).text()).toContain("Not running");
    const editor = await (await get(fixture, "/sites/site-1/regions/home.hero")).text();
    expect(editor).toContain("is not running.");
  });

  it("say it is running when it is", async () => {
    const { open, server: listening } = await ports();
    server = listening;
    fixture = makeSite({ schema: SCHEMA, devUrl: `http://127.0.0.1:${open}` });

    expect(await (await get(fixture, "/")).text()).toContain(`Running at 127.0.0.1:${open}`);
    expect(await (await get(fixture, "/sites/site-1/regions/home.hero")).text()).not.toContain(
      "live-down",
    );
  });
});

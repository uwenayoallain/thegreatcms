/** Many sites' previews from one proxy: routed by host, each dev server started when first asked for. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreviewSitesServer, devCommand } from "./previews.js";

let root: string;
let listFile: string;
const servers: ReturnType<typeof createPreviewSitesServer>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-previews-"));
  listFile = join(root, "sites.json");
});

afterEach(() => {
  for (const { server, sites } of servers.splice(0)) {
    sites.stopAll();
    server.close();
  }
  rmSync(root, { recursive: true, force: true });
});

function site(name: string, pkg: object, files: Record<string, string> = {}) {
  const path = join(root, name);
  mkdirSync(join(path, "node_modules"), { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify(pkg));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  return path;
}

/** A site whose "dev server" answers with its own name. */
function answering(name: string) {
  return site(
    name,
    { scripts: { dev: "node server.js" } },
    {
      "server.js": `require("node:http").createServer((req, res) => res.end("${name} " + process.env.PREVIEW_HOST + " " + req.url)).listen(process.env.PORT, "127.0.0.1");`,
    },
  );
}

function list(sites: Array<{ host: string; path: string }>) {
  writeFileSync(
    listFile,
    JSON.stringify({
      version: 1,
      sites: sites.map((s, i) => ({ id: String(i), name: s.host, ...s })),
    }),
  );
}

async function up() {
  const started = createPreviewSitesServer({
    sitesFile: listFile,
    port: 0,
    firstUpstream: 4700 + Math.floor(Math.random() * 200) * 2,
    idle: 60,
    startTimeout: 20,
    log: () => {},
  });
  await new Promise<void>((resolve) => started.server.listen(0, "127.0.0.1", resolve));
  servers.push(started);
  return { ...started, port: (started.server.address() as AddressInfo).port };
}

function get(port: number, host: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const until = (check: () => Promise<boolean>) =>
  expect.poll(check, { timeout: 15000, interval: 150 }).toBe(true);

describe("finding a site's dev server", () => {
  it("knows each framework's command, and installs first when there is no node_modules", () => {
    const astro = site("astro", { dependencies: { astro: "5" } });
    expect(devCommand(astro)).toEqual({
      command: 'exec node_modules/.bin/astro dev --host 127.0.0.1 --port "$PORT" --ignore-lock',
    });

    const next = join(root, "next");
    mkdirSync(next);
    writeFileSync(join(next, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    writeFileSync(join(next, "pnpm-lock.yaml"), "");
    expect(devCommand(next)).toEqual({
      command:
        'pnpm install --frozen-lockfile && exec node_modules/.bin/next dev --hostname 127.0.0.1 --port "$PORT"',
    });

    expect(
      devCommand(site("kit", { devDependencies: { "@sveltejs/kit": "2", vite: "7" } })),
    ).toEqual({ command: expect.stringContaining("node_modules/.bin/vite dev") });
    expect(devCommand(site("other", { scripts: { dev: "node server.js" } }))).toEqual({
      command: "exec npm run dev",
    });
    expect(devCommand(site("none", {}))).toHaveProperty("problem");
    expect(devCommand(join(root, "missing"))).toHaveProperty("problem");
  });
});

describe("one proxy for every site", () => {
  it("routes each host to its own site's dev server, telling it the name it answers to", async () => {
    list([
      { host: "one-preview.example.com", path: answering("one") },
      { host: "two-preview.example.com", path: answering("two") },
    ]);
    const { port, sites } = await up();

    const first = await get(port, "one-preview.example.com", "/page");
    expect(first.status).toBe(503);
    expect(first.body).toContain("Starting the preview");

    await until(async () => (await get(port, "one-preview.example.com")).status === 200);
    expect((await get(port, "one-preview.example.com", "/page")).body).toBe(
      "one one-preview.example.com /page",
    );
    await until(async () => (await get(port, "TWO-preview.example.com:443")).status === 200);
    expect((await get(port, "two-preview.example.com", "/x")).body).toBe(
      "two two-preview.example.com /x",
    );
    expect(sites.status().map((entry) => entry.state)).toEqual(["running", "running"]);
  }, 30000);

  it("starts a site's dev server when warmed, without waiting for it", async () => {
    list([{ host: "warm-preview.example.com", path: answering("warm") }]);
    const { port, sites } = await up();

    expect((await get(port, "warm-preview.example.com", "/__greatcms/warm")).status).toBe(204);
    expect(sites.status()[0]?.state).toBe("starting");
    await until(async () => (await get(port, "warm-preview.example.com")).status === 200);
  }, 30000);

  it("serves nothing for a host the studio did not list", async () => {
    list([{ host: "one-preview.example.com", path: answering("one") }]);
    const { port } = await up();
    const answer = await get(port, "other-preview.example.com");
    expect(answer.status).toBe(404);
    expect(answer.body).toContain("No site is previewed at this address");
  });

  it("picks up a site connected later, and stops one disconnected", async () => {
    list([]);
    const { port, sites } = await up();
    expect((await get(port, "late-preview.example.com")).status).toBe(404);

    // A new modification time, even within the same millisecond as the first write.
    await new Promise((resolve) => setTimeout(resolve, 20));
    list([{ host: "late-preview.example.com", path: answering("late") }]);
    await until(async () => (await get(port, "late-preview.example.com")).status === 200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    list([]);
    expect((await get(port, "late-preview.example.com")).status).toBe(404);
    expect(sites.status()).toEqual([]);
  }, 30000);

  it("says why a site cannot be previewed instead of failing silently", async () => {
    list([{ host: "bare-preview.example.com", path: site("bare", {}) }]);
    const { port } = await up();
    const answer = await get(port, "bare-preview.example.com");
    expect(answer.status).toBe(503);
    expect(answer.body).toContain("no framework this service knows");
  });
});

/** The server around the routes: stopping, restarting, headers on everything, and answers that are never stale. */

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Store } from "../src/db.js";
import { LocalRepository } from "../src/repo.js";
import { findFolded } from "../src/search.js";
import { shutDown } from "../src/shutdown.js";
import { SiteClient } from "../src/sites.js";
import { type Fixture, makeSite, PASSWORD, post, SECRET, signedIn, SITE_ID } from "./site.js";

const SCHEMA = `version: 1
site:
  name: Example
regions:
  home.hero:
    label: Hero
    fields:
      heading: { type: text }
collections:
  posts:
    label: Posts
    path: content/posts
    format: json
    fields:
      title: { type: text, required: true }
`;

let site: Fixture;
beforeEach(() => {
  site = makeSite({
    schema: SCHEMA,
    files: { "content/posts/first.json": '{"title":"First"}\n' },
  });
});
afterEach(() => site.cleanup());

const get = (path: string, headers: Record<string, string> = signedIn) =>
  site.app.request(path, { headers });

const fakeServer = (order: string[]) => ({
  close: (done?: () => void) => {
    order.push("server closed");
    done?.();
  },
  closeIdleConnections: () => order.push("idle connections closed"),
  closeAllConnections: () => order.push("all connections closed"),
});

describe("stopping", () => {
  it("lets a publish in flight finish before the database closes", async () => {
    const order: string[] = [];
    const { promise: publishing, resolve: finish } = Promise.withResolvers<void>();
    const stopped = shutDown({
      server: fakeServer(order),
      settled: () => publishing.then(() => void order.push("publish finished")),
      close: () => order.push("database closed"),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).not.toContain("database closed");
    finish();
    expect(await stopped).toBe(0);
    expect(order).toEqual([
      "server closed",
      "idle connections closed",
      "publish finished",
      "database closed",
    ]);
  });

  it("closes anyway, and says so, when work outlasts the deadline", async () => {
    const order: string[] = [];
    const code = await shutDown({
      server: fakeServer(order),
      settled: () => new Promise(() => {}),
      close: () => order.push("database closed"),
      deadlineMs: 20,
      log: (line) => order.push(line),
    });
    expect(code).toBe(1);
    expect(order.at(-1)).toBe("database closed");
    expect(order.join("\n")).toContain("still in flight");
  });

  it("waits for a real publish, which is one commit or none", async () => {
    const { publishesSettled } = await import("../src/repo.js");
    const publish = post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      "f[heading]": "Written while stopping",
      headSha: site.head(),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await publishesSettled();
    await publish;
    expect(site.read("content/cms/home.hero.json")).toContain("Written while stopping");
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: site.root, encoding: "utf8" }),
    ).toBe("");
  });
});

describe("the built server", () => {
  const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));

  it("starts, clears what a stopped run left behind, and exits cleanly when asked to stop", async () => {
    const data = mkdtempSync(join(tmpdir(), "greatcms-main-"));
    const sites = join(data, "sites");
    mkdirSync(join(sites, ".half.cloning"), { recursive: true });
    const child = spawn(process.execPath, [main], {
      env: {
        ...process.env,
        STUDIO_PASSWORD: "a password for the test",
        STUDIO_DB: join(data, "studio.sqlite"),
        STUDIO_SITES_ROOT: sites,
        PORT: "0",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    try {
      const port = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no start: ${output}`)), 20_000);
        child.stdout.on("data", () => {
          const found = /localhost:(\d+)/.exec(output)?.[1];
          if (found) {
            clearTimeout(timer);
            resolve(found);
          }
        });
      });
      const response = await fetch(`http://127.0.0.1:${port}/sign-in`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(existsSync(join(sites, ".half.cloning"))).toBe(false);

      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe("a scheduled publish", () => {
  it("taken by a run that stopped is picked up by the next one", () => {
    const store = new Store(":memory:");
    store.addSite({ id: "s", name: "S", path: "/tmp/s", devUrl: "", createdAt: "2026-01-01" });
    const job = store.schedule({
      siteId: "s",
      target: "regions/home.hero",
      label: "home.hero",
      form: [["heading", "Later"]],
      dueAt: 1000,
      actor: "studio",
      author: null,
    });
    expect(store.claimScheduled(job.id)).toBe(true);
    expect(store.dueScheduled(2000)).toEqual([]);
    expect(store.recoverScheduled()).toBe(1);
    expect(store.dueScheduled(2000).map((due) => due.id)).toEqual([job.id]);
    expect(store.recoverScheduled()).toBe(0);
  });
});

describe("headers on every response", () => {
  it("cover a download, an asset, an image and an error, not only pages", async () => {
    for (const path of ["/inbox.csv", "/assets/studio.css", "/favicon.svg", "/nowhere", "/"]) {
      // oxlint-disable-next-line no-await-in-loop -- each is its own request
      const response = await get(path);
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("referrer-policy"), path).toBe("same-origin");
      expect(response.headers.get("permissions-policy"), path).toContain("camera=()");
    }
  });

  it("keep a browser on HTTPS for everything once it arrived over it", async () => {
    const app = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      trustProxy: true,
    });
    const secure = await app.request("/inbox.csv", {
      headers: { ...signedIn, "x-forwarded-proto": "https" },
    });
    expect(secure.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect((await get("/inbox.csv")).headers.get("strict-transport-security")).toBeNull();
  });

  it("say how long the studio took, only to someone signed in", async () => {
    expect((await get(`/sites/${SITE_ID}`)).headers.get("server-timing")).toMatch(
      /^app;dur=\d+\.\d$/,
    );
    expect((await get("/sign-in", {})).headers.get("server-timing")).toBeNull();
  });

  it("compress a page with Brotli where the browser takes it, intact", async () => {
    const plain = await (await get(`/sites/${SITE_ID}`)).text();
    const packed = await get(`/sites/${SITE_ID}`, { ...signedIn, "accept-encoding": "gzip, br" });
    expect(packed.headers.get("content-encoding")).toBe("br");
    expect(packed.headers.get("vary")).toMatch(/accept-encoding/i);
    expect(packed.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const body = brotliDecompressSync(Buffer.from(await packed.arrayBuffer())).toString();
    // Only the commit times of the two renders can differ.
    expect(body.length).toBe(plain.length);
    expect(Number(packed.headers.get("content-length"))).toBeLessThan(plain.length / 2);
  });
});

describe("what an editor sees is never stale", () => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: site.root, encoding: "utf8" }).trim();

  it("follows a branch changed, a remote added and a remote moved in a terminal", async () => {
    const repo = new LocalRepository(site.root);
    expect(await repo.branchState()).toMatchObject({ branch: "main", remote: null });
    git("switch", "-q", "-c", "drafts");
    expect((await repo.branchState()).branch).toBe("drafts");
    git("remote", "add", "origin", "https://example.com/one.git");
    expect(await repo.branchState()).toMatchObject({
      remote: "origin",
      remoteUrl: "https://example.com/one.git",
    });
    git("remote", "set-url", "origin", "https://example.com/two.git");
    expect((await repo.branchState()).remoteUrl).toBe("https://example.com/two.git");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect((await repo.branchState()).defaultBranch).toBe("trunk");
    git("checkout", "-q", "--detach");
    expect((await repo.branchState()).branch).toBeNull();
  });

  it("lists an entry as it is on disk now: edited to the same length, added, removed", async () => {
    const client = new SiteClient(site.store.getSite(SITE_ID)!);
    const titles = async () =>
      (await client.listEntries(await client.context(), "posts")).map((entry) => entry.data.title);
    const file = join(site.root, "content/posts/first.json");
    // Old enough to be remembered, as a file nobody is editing would be.
    execFileSync("touch", ["-d", "2 hours ago", file]);
    expect(await titles()).toEqual(["First"]);
    expect(await titles()).toEqual(["First"]);

    writeFileSync(file, '{"title":"Other"}\n');
    execFileSync("touch", ["-d", "2 hours ago", file]);
    expect(await titles()).toEqual(["Other"]);

    site.write("content/posts/second.json", '{"title":"Second"}\n');
    expect((await titles()).toSorted()).toEqual(["Other", "Second"]);
    unlinkSync(file);
    expect(await titles()).toEqual(["Second"]);
  });

  it("does not read an entry swapped for a link to somewhere outside the site", async () => {
    const client = new SiteClient(site.store.getSite(SITE_ID)!);
    const outside = mkdtempSync(join(tmpdir(), "greatcms-outside-"));
    try {
      writeFileSync(join(outside, "secret.json"), '{"title":"Secret"}\n');
      const file = join(site.root, "content/posts/first.json");
      execFileSync("touch", ["-d", "2 hours ago", file]);
      await client.listEntries(await client.context(), "posts");
      unlinkSync(file);
      symlinkSync(join(outside, "secret.json"), file);
      expect(await client.listEntries(await client.context(), "posts")).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("finds the same matches, at the same places, as folding letter by letter did", () => {
    expect(findFolded("Un café à Kigali", "cafe a")).toEqual([3, 9]);
    expect(findFolded("Café society", "café")).toEqual([0, 5]);
    expect(findFolded("STRASSE und Straße", "straße")).toEqual([12, 18]);
    expect(findFolded("nothing here", "café")).toBeUndefined();
  });
});

describe("git in a site's folder runs nothing of the folder's", () => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: site.root, encoding: "utf8" }).trim();

  it("ignores an external diff command set in the folder's config", async () => {
    const marker = join(site.root, "ran-diff");
    git("config", "diff.external", `sh -c 'touch ${marker}' --`);
    const head = site.head();
    site.commit("content/posts/second.json", '{"title":"Second"}\n');
    const response = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      "f[heading]": "Changed",
      headSha: head,
    });
    expect(response.status).toBe(200);
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs a remote that is a command, even where the folder's config allows it", async () => {
    const marker = join(site.root, "ran-remote");
    git("config", "protocol.ext.allow", "always");
    git("remote", "add", "origin", `ext::sh -c touch% ${marker}`);
    const pushed = await new LocalRepository(site.root).push();
    expect(pushed.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps a password in the remote's address out of what a failed push says", async () => {
    git("remote", "add", "origin", "http://deploy:hunter2secret@127.0.0.1:9/site.git");
    const pushed = await new LocalRepository(site.root).push();
    expect(pushed.ok).toBe(false);
    expect(JSON.stringify(pushed)).not.toContain("hunter2secret");
  });
});

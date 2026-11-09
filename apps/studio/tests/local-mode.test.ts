/** Local mode, over a real socket: who the studio answers, and how the one-time link signs a browser in. */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopback, localGuard, loopbackAddress } from "../src/local.js";
import { type RunningLocalStudio, startLocal } from "../src/start.js";
import { type Fixture, makeSite } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Hero
    fields:
      heading: { type: text, default: Hello }
`;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** node:http rather than fetch: the tests need to say exactly what `Host` is. */
function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const cookieOf = (reply: Reply) => String(reply.headers["set-cookie"]).split(";")[0] as string;

let site: Fixture;
let stateDir: string;
let studio: RunningLocalStudio | undefined;
let port: number;

async function open(overrides: Partial<Parameters<typeof startLocal>[0]> = {}) {
  port = await freePort();
  studio = await startLocal({ root: site.root, name: "My Site", stateDir, port, ...overrides });
  return studio;
}

const linkPath = () => new URL(studio!.signInUrl!).pathname + new URL(studio!.signInUrl!).search;

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
  stateDir = mkdtempSync(join(tmpdir(), "greatcms-state-"));
});

afterEach(async () => {
  await studio?.close();
  studio = undefined;
  site.store.close();
  site.cleanup();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("the one-time sign-in link", () => {
  it("signs a browser in once, and lands on the site's editor", async () => {
    const running = await open();
    expect(running.signInUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${port}/local/sign-in\\?token=[\\w-]{43}$`),
    );

    const first = await send(port, linkPath());
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/sites/my-site");
    expect(String(first.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Lax/);

    const editor = await send(port, "/sites/my-site/regions/home.hero", {
      headers: { cookie: cookieOf(first) },
    });
    expect(editor.status).toBe(200);
    expect(editor.body).toContain("Hero");
  });

  it("is refused the second time, and says so in the terminal's terms", async () => {
    await open();
    await send(port, linkPath());
    const again = await send(port, linkPath());
    expect(again.status).toBe(403);
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect(again.body).toContain("greatcms studio");
  });

  it("sends the browser it signed in back to the editor when the link is reopened", async () => {
    await open();
    const first = await send(port, linkPath());
    const again = await send(port, linkPath(), { headers: { cookie: cookieOf(first) } });
    expect(again.status).toBe(303);
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a wrong or missing token without spending the real one", async () => {
    await open();
    for (const path of ["/local/sign-in", "/local/sign-in?token=", "/local/sign-in?token=nope"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      expect((await send(port, path)).status).toBe(403);
    }
    expect((await send(port, linkPath())).status).toBe(303);
  });

  it("is a page load only: a POST cannot exchange the token", async () => {
    await open();
    expect((await send(port, linkPath(), { method: "POST" })).status).toBe(405);
    expect((await send(port, linkPath())).status).toBe(303);
  });

  it("is new on every run, and the old one stops working", async () => {
    await open();
    const stale = linkPath();
    await studio!.close();
    await open();
    expect(linkPath()).not.toBe(stale);
    const reply = await send(port, stale);
    expect(reply.status).toBe(403);
  });
});

describe("what the studio answers without the link", () => {
  it("sends a signed-out page load to an explanation, never a password form", async () => {
    await open();
    const page = await send(port, "/sites/my-site");
    expect(page.status).toBe(303);
    expect(page.headers.location).toMatch(/^\/sign-in/);

    const signIn = await send(port, "/sign-in");
    expect(signIn.status).toBe(401);
    expect(signIn.body).not.toContain("<form");
    expect(signIn.body).toContain("one-time sign-in link");
  });

  it("takes no password at all", async () => {
    await open();
    const reply = await send(port, "/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=anything",
    });
    expect(reply.status).toBe(403);
    expect(reply.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a signed-out form post", async () => {
    await open();
    const reply = await send(port, "/sites/my-site/regions/home.hero", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "heading=Changed",
    });
    expect(reply.status).toBe(401);
  });
});

describe("the Host check", () => {
  it("refuses a name that is not this machine, whatever the port", async () => {
    await open();
    for (const host of [
      `evil.example:${port}`,
      "evil.example",
      `127.0.0.1.evil.example:${port}`,
      `localhost.evil.example:${port}`,
      `192.168.1.10:${port}`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await send(port, linkPath(), { headers: { host } });
      expect(reply.status, host).toBe(403);
      expect(reply.headers["set-cookie"], host).toBeUndefined();
    }
    expect((await send(port, linkPath())).status).toBe(303);
  });

  it("refuses the right name on the wrong port", async () => {
    await open();
    for (const host of [`127.0.0.1:${port + 1}`, "127.0.0.1", "localhost:80"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      expect((await send(port, "/", { headers: { host } })).status, host).toBe(403);
    }
  });

  it("refuses a rebound name even with a valid session", async () => {
    await open();
    const first = await send(port, linkPath());
    const reply = await send(port, "/sites/my-site", {
      headers: { host: `rebound.example:${port}`, cookie: cookieOf(first) },
    });
    expect(reply.status).toBe(403);
    expect(reply.body).not.toContain("Hero");
  });

  it("sends localhost to the one address the cookie lives on, and only for page loads", async () => {
    await open();
    const load = await send(port, "/sites/my-site?x=1", { headers: { host: `localhost:${port}` } });
    expect(load.status).toBe(307);
    expect(load.headers.location).toBe(`http://127.0.0.1:${port}/sites/my-site?x=1`);

    const post = await send(port, "/theme", {
      method: "POST",
      headers: { host: `localhost:${port}`, "content-type": "application/x-www-form-urlencoded" },
      body: "theme=dark",
    });
    expect(post.status).toBe(403);
  });

  it("lets nothing through to the app when the header is missing", async () => {
    let reached = false;
    const guarded = localGuard(
      () => {
        reached = true;
        return new Response("app");
      },
      { port: 4983, urlHost: "127.0.0.1", token: "t", signingKey: "k", landing: "/" },
    );
    const reply = await guarded(new Request("http://127.0.0.1:4983/"));
    expect(reply.status).toBe(403);
    expect(reached).toBe(false);
  });
});

describe("cross-site protection stays on", () => {
  it("refuses a form post from another origin, session or not", async () => {
    await open();
    const first = await send(port, linkPath());
    const headers = {
      cookie: cookieOf(first),
      "content-type": "application/x-www-form-urlencoded",
    };
    const path = "/sites/my-site/regions/home.hero";

    for (const origin of ["https://evil.example", `http://localhost:${port}`, "null"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const crossed = await send(port, path, {
        method: "POST",
        headers: { ...headers, origin },
        body: "heading=Changed",
      });
      expect(crossed.status, origin).toBe(403);
    }
    expect(site.exists("content/cms/home.hero.json")).toBe(false);

    const own = await send(port, path, {
      method: "POST",
      headers: { ...headers, origin: `http://127.0.0.1:${port}` },
      body: "heading=Changed",
    });
    expect(own.status).toBeLessThan(400);
  });

  it("keeps the studio's own headers on its pages", async () => {
    await open();
    const first = await send(port, linkPath());
    const page = await send(port, "/sites/my-site", { headers: { cookie: cookieOf(first) } });
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
  });
});

describe("where it listens", () => {
  it("knows loopback from everything else", () => {
    for (const host of ["127.0.0.1", "127.8.9.1", "localhost", "LOCALHOST", "::1", "[::1]"]) {
      expect(isLoopback(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.4", "example.com", "127.0.0.1.example.com"]) {
      expect(isLoopback(host), host).toBe(false);
    }
    expect(loopbackAddress("localhost")).toEqual({ bind: "127.0.0.1", urlHost: "127.0.0.1" });
    expect(loopbackAddress("[::1]")).toEqual({ bind: "::1", urlHost: "[::1]" });
  });

  it("refuses any other address without a password, and says why", async () => {
    port = await freePort();
    await expect(
      startLocal({ root: site.root, name: "My Site", stateDir, port, host: "0.0.0.0" }),
    ).rejects.toThrow(/without a password[\s\S]*STUDIO_PASSWORD/);
    // Nothing was left listening.
    await expect(send(port, "/")).rejects.toThrow();
  });

  it("with a password, offers no link and asks for the password instead", async () => {
    const running = await open({ host: "0.0.0.0", password: "a long test password" });
    expect(running.signInUrl).toBeUndefined();
    const link = await send(port, "/local/sign-in?token=anything");
    expect(link.headers.location).toMatch(/^\/sign-in/);
    expect(link.headers["set-cookie"]).toBeUndefined();

    const form = await send(port, "/sign-in");
    expect(form.status).toBe(200);
    expect(form.body).toContain("<form");

    const signedIn = await send(port, "/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=a+long+test+password",
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers["set-cookie"]).toBeDefined();
  });

  it("does not answer on another interface", async () => {
    await open();
    // Bound to 127.0.0.1 alone: the IPv6 loopback is a different socket nobody is listening on.
    await expect(
      new Promise((resolve, reject) => {
        request({ host: "::1", port, path: "/" }, resolve).on("error", reject).end();
      }),
    ).rejects.toThrow();
  });
});

describe("state", () => {
  it("keeps the secret private, and a session across a restart", async () => {
    await open();
    const secret = join(stateDir, "secret");
    if (process.platform !== "win32") expect(statSync(secret).mode & 0o777).toBe(0o600);
    const before = readFileSync(secret, "utf8");
    const first = await send(port, linkPath());

    await studio!.close();
    await open();
    expect(readFileSync(secret, "utf8")).toBe(before);
    const page = await send(port, "/sites/my-site", { headers: { cookie: cookieOf(first) } });
    expect(page.status).toBe(200);
  });

  it("writes nothing into the site's folder", async () => {
    await open();
    await send(port, linkPath());
    site.git(["add", "-A"]);
    site.git(["diff", "--cached", "--quiet"]);
  });

  it("follows the folder when the cache remembers another one", async () => {
    await open();
    await studio!.close();
    const moved = makeSite({ schema: SCHEMA });
    try {
      port = await freePort();
      studio = await startLocal({ root: moved.root, name: "My Site", stateDir, port });
      const first = await send(port, linkPath());
      const page = await send(port, "/sites/my-site", { headers: { cookie: cookieOf(first) } });
      expect(page.status).toBe(200);
    } finally {
      await studio?.close();
      studio = undefined;
      moved.store.close();
      moved.cleanup();
    }
  });
});

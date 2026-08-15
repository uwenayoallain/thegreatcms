/** The attacks a self-hosted studio actually faces, each one proven to land before it was closed. */

/* oxlint-disable no-await-in-loop -- a rate limit is a claim about order: these requests go one at a time */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR } from "@greatcms/conformance";
import { DEFAULT_CONFIG } from "@greatcms/spec";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";
import { prepareUpload, UploadError } from "../src/media.js";

const PASSWORD = "correct-horse-battery-staple";
const SECRET = "test-secret";
const SITE = {
  id: "site-1",
  name: "Example",
  owner: "ada",
  repo: "site",
  branch: "main",
  token: "token",
  publishMode: "direct" as const,
  aiTitles: false,
  createdAt: "2026-08-12",
};

const fixture = (path: string) => readFileSync(join(FIXTURES_DIR, path), "utf8");

/** A fake GitHub that records every path a commit tries to write. */
function fakeGitHub() {
  const files = new Map<string, string>([
    [".cms/schema.yaml", fixture(".cms/schema.yaml")],
    [".cms/config.yaml", fixture(".cms/config.yaml")],
  ]);
  const written: string[] = [];
  const state = { head: "head-1", blobs: new Map<string, string>() };

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && pathname.includes("/contents/")) {
      const path = decodeURIComponent(pathname.split("/contents/")[1] ?? "");
      const content = files.get(path);
      if (content === undefined) return json({ message: "Not Found" }, 404);
      return json({
        type: "file",
        sha: `sha-${path}`,
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
      });
    }
    if (method === "GET" && pathname.includes("/git/ref/heads/")) {
      return json({ object: { sha: state.head } });
    }
    if (method === "GET" && pathname.includes("/git/commits/"))
      return json({ tree: { sha: "t1" } });
    if (method === "POST" && pathname.endsWith("/git/blobs")) {
      const sha = `blob-${state.blobs.size + 1}`;
      state.blobs.set(sha, String(body.content));
      return json({ sha });
    }
    if (method === "POST" && pathname.endsWith("/git/trees")) {
      for (const entry of body.tree as Array<{ path: string }>) written.push(entry.path);
      return json({ sha: "t2" });
    }
    if (method === "POST" && pathname.endsWith("/git/commits")) {
      state.head = "commit-2";
      return json({ sha: state.head, html_url: "https://gh/commit-2" });
    }
    if (method === "PATCH" && pathname.includes("/git/refs/heads/")) return json({ ok: true });
    return json({ message: `unhandled ${method} ${pathname}` }, 500);
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, written };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let github: ReturnType<typeof fakeGitHub>;
let store: Store;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  github = fakeGitHub();
  store = new Store(":memory:");
  store.addSite(SITE);
  app = createApp({ store, password: PASSWORD, secret: SECRET, fetch: github.fetchImpl });
});

const signedIn = {
  cookie: createSessionCookie(sessionKey(SECRET, PASSWORD)).split(";")[0] as string,
};

function post(path: string, fields: Record<string, string>, headers = signedIn) {
  return app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("guessing the password", () => {
  it("stops answering after ten wrong attempts, and says when to come back", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      codes.push((await post("/sign-in", { password: `guess-${i}` }, {})).status);
    }

    expect(codes.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401));
    expect(codes.slice(10)).toEqual([429, 429]);

    const blocked = await post("/sign-in", { password: `guess` }, {});
    expect(await blocked.text()).toContain("Too many attempts");
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("does not hold a mistyped password against you once you get it right", async () => {
    for (let i = 0; i < 9; i += 1) await post("/sign-in", { password: "wrong" }, {});
    expect((await post("/sign-in", { password: PASSWORD }, {})).status).toBe(303);

    // The counter reset, so the next nine mistakes are answered rather than blocked.
    for (let i = 0; i < 9; i += 1) {
      expect((await post("/sign-in", { password: "wrong" }, {})).status).toBe(401);
    }
  });

  it("keeps the throttle after a correct password from somewhere else", async () => {
    // Every request here shares one address, which is the conservative direction.
    for (let i = 0; i < 11; i += 1) await post("/sign-in", { password: "wrong" }, {});
    expect((await post("/sign-in", { password: PASSWORD }, {})).status).toBe(429);
  });
});

describe("sessions", () => {
  it("stops working when the password changes", async () => {
    const rotated = createApp({
      store,
      password: "a-brand-new-password",
      secret: SECRET,
      fetch: github.fetchImpl,
    });

    const response = await rotated.request("/", { headers: signedIn });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("marks the cookie Secure when the request arrived over HTTPS", async () => {
    const response = await app.request("https://studio.example/sign-in", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://studio.example",
      },
      body: new URLSearchParams({ password: PASSWORD }),
    });

    expect(response.headers.get("set-cookie")).toContain("; Secure");
  });

  it("leaves Secure off over plain HTTP, where it would lock you out", async () => {
    const response = await post("/sign-in", { password: PASSWORD }, {});
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });
});

describe("cross-site requests", () => {
  it("refuses a post whose Referer is another site", async () => {
    const response = await post(
      "/sites/site-1/regions/home.hero",
      { "f[heading]": "Hi" },
      { ...signedIn, referer: "https://evil.example/page" },
    );

    expect(response.status).toBe(403);
  });

  it("refuses a post from an opaque origin, which is a sandboxed frame", async () => {
    const response = await post(
      "/sites/site-1/regions/home.hero",
      { "f[heading]": "Hi" },
      { ...signedIn, origin: "null" },
    );

    expect(response.status).toBe(403);
  });

  it("still allows a client that sends neither header, which is curl, not a browser", async () => {
    const response = await post("/sites/site-1/regions/home.hero", { "f[heading]": "Hi" });
    expect(response.status).toBe(200);
  });
});

describe("an entry slug is one file name", () => {
  const climbing = encodeURIComponent("../../.github/workflows/pwn");

  it("commits nothing when a slug tries to climb out of the collection", async () => {
    const response = await post(`/sites/site-1/collections/blog/${climbing}`, {
      "f[title]": "X",
      "f[date]": "2026-01-01",
    });

    expect(response.status).toBe(404);
    expect(github.written).toEqual([]);
  });

  it("refuses to open or delete one either", async () => {
    expect(
      (await app.request(`/sites/site-1/collections/blog/${climbing}`, { headers: signedIn }))
        .status,
    ).toBe(404);
    expect((await post(`/sites/site-1/collections/blog/${climbing}/delete`, {})).status).toBe(404);
    expect(github.written).toEqual([]);
  });

  it("still publishes an ordinary slug", async () => {
    const response = await post("/sites/site-1/collections/blog/hello-world", {
      "f[title]": "Hello world",
      "f[date]": "2026-01-01",
    });

    expect(response.status).toBe(200);
    expect(github.written).toContain("content/blog/hello-world.md");
  });
});

/** A minimal but real PNG: the signature plus an IHDR carrying its dimensions. */
function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 4);
  view.setUint32(20, 3);
  return bytes;
}

const upload = (fileName: string, type: string, bytes: Uint8Array) =>
  prepareUpload(DEFAULT_CONFIG, { fileName, type, bytes });

describe("uploads", () => {
  it("refuses a document wearing an image's content type", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

    expect(() => upload("logo.png", "image/png", svg)).toThrow(UploadError);
    expect(() => upload("logo.png", "image/png", svg)).toThrow(/not image\/png/);
  });

  it("refuses an image whose bytes are a different format than claimed", () => {
    expect(() => upload("shot.jpg", "image/jpeg", pngBytes())).toThrow(/image\/png/);
  });

  it("accepts an image that is what it says it is", () => {
    expect(upload("shot.png", "image/png", pngBytes()).path).toMatch(/\.png$/);
  });
});

describe("the public submission endpoint", () => {
  const submit = (body: URLSearchParams, headers: Record<string, string> = {}) =>
    app.request("/f/site-1/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    });

  it("refuses a body too large to be a contact form", async () => {
    const body = new URLSearchParams({ message: "x".repeat(100_000) });
    const response = await submit(body);

    expect(response.status).toBe(413);
    expect(store.listSubmissions({})).toEqual([]);
  });

  it("refuses a submission with an absurd number of fields", async () => {
    const body = new URLSearchParams();
    for (let i = 0; i < 200; i += 1) body.set(`field${i}`, "x");
    const response = await submit(body, { "content-length": "0" });

    expect(response.status).toBe(413);
    expect(store.listSubmissions({})).toEqual([]);
  });

  it("does not let a forged forwarding header buy a fresh rate limit", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const response = await submit(new URLSearchParams({ message: "hi" }), {
        "x-forwarded-for": `10.0.0.${i}`,
      });
      codes.push(response.status);
    }

    expect(codes).toContain(429);
  });

  it("honours the header when the studio is told it sits behind a proxy", async () => {
    const proxied = createApp({
      store,
      password: PASSWORD,
      secret: SECRET,
      fetch: github.fetchImpl,
      trustProxy: true,
    });

    const codes: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const response = await proxied.request("/f/site-1/contact", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": `10.0.0.${i}`,
        },
        body: new URLSearchParams({ message: "hi" }),
      });
      codes.push(response.status);
    }

    expect(codes).not.toContain(429);
  });

  it("still refuses to redirect a visitor off-site", async () => {
    const response = await submit(
      new URLSearchParams({ message: "hi", _redirect: "https://evil.example" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});

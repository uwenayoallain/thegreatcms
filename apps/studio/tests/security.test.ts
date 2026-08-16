/** The attacks a self-hosted studio actually faces, each one proven to land before it was closed. */

/* oxlint-disable no-await-in-loop -- a rate limit is a claim about order: these requests go one at a time */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DEFAULT_CONFIG } from "@greatcms/spec";
import { prepareUpload, UploadError } from "../src/media.js";
import { makeSite, PASSWORD, SECRET, signedIn, type Fixture } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }
      subtitle: { type: text }
collections:
  blog:
    label: Blog
    path: content/blog
    format: markdown
    body: content
    slug: title
    fields:
      title: { type: text, required: true }
      date: { type: date }
      content: { type: richtext }
`;

let site: Fixture;

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
});

afterEach(() => site.cleanup());

/** Every path the site writes to, so a test can assert nothing escaped. */
const written = () => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(site.root, dir), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out;
};

function post(path: string, fields: Record<string, string>, headers = signedIn) {
  return site.app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

const app = {
  request: (...args: Parameters<Fixture["app"]["request"]>) => site.app.request(...args),
};
const store = {
  listSites: () => site.store.listSites(),
  listSubmissions: (o: Parameters<Fixture["store"]["listSubmissions"]>[0]) =>
    site.store.listSubmissions(o),
};

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
      store: site.store,
      password: "a-brand-new-password",
      secret: SECRET,
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
    expect(written().filter((path) => path.startsWith("content/"))).toEqual([]);
  });

  it("refuses to open or delete one either", async () => {
    expect(
      (await app.request(`/sites/site-1/collections/blog/${climbing}`, { headers: signedIn }))
        .status,
    ).toBe(404);
    expect((await post(`/sites/site-1/collections/blog/${climbing}/delete`, {})).status).toBe(404);
    expect(written().filter((path) => path.startsWith("content/"))).toEqual([]);
  });

  it("still publishes an ordinary slug", async () => {
    const response = await post("/sites/site-1/collections/blog/hello-world", {
      "f[title]": "Hello world",
      "f[date]": "2026-01-01",
    });

    expect(response.status).toBe(200);
    expect(written()).toContain("content/blog/hello-world.md");
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
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
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

describe("headers on every page", () => {
  it("refuses to be framed, so nobody can overlay their UI on Publish", async () => {
    const response = await app.request("/sign-in");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("confines scripts and forms to this origin", async () => {
    const csp = (await app.request("/sign-in")).headers.get("content-security-policy") ?? "";

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("allows framing a dev server over http, but not javascript: or data:", async () => {
    const csp = (await app.request("/sign-in")).headers.get("content-security-policy") ?? "";
    const frame = csp.split("; ").find((directive) => directive.startsWith("frame-src"));

    expect(frame).toBe("frame-src 'self' http: https:");
  });

  it("sends nosniff, a same-origin referrer policy, and no-store", async () => {
    const response = await app.request("/sign-in");

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Deliberately not `no-referrer`: with it Chrome sends `Origin: null` on a
    // same-origin form post, which the CSRF check refuses, and every form in
    // this app stops working without JavaScript. The browser suite catches it.
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("leaves the cacheable asset route alone", async () => {
    const response = await app.request("/assets/editor.js", { headers: signedIn });

    // Only documents get no-store; a bundle that changes with a deploy should
    // still be cached the way it was.
    expect(response.headers.get("cache-control")).not.toBe("no-store");
  });
});

describe("the dev server URL", () => {
  const connect = (devUrl: string) =>
    post("/sites", { name: "Local", path: "/tmp/whatever", devUrl });

  it("refuses a javascript: URL, which would run as the studio", async () => {
    const response = await connect("javascript:fetch('/sites/site-1/delete',{method:'POST'})");

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("http:// or https://");
    expect(store.listSites().map((entry) => entry.name)).not.toContain("Local");
  });

  it("refuses a data: URL, which is an origin of its own", async () => {
    expect((await connect("data:text/html,<script>alert(1)</script>")).status).toBe(422);
  });

  it("still takes an ordinary dev server", async () => {
    // It gets as far as reading the folder, which is past the URL check.
    const response = await connect("http://localhost:4321");
    expect(await response.text()).not.toContain("http:// or https://");
  });
});

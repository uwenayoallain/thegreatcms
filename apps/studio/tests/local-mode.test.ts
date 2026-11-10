/** Local mode, over a real socket: nobody signs in, and what keeps a web page from being the owner. */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopback, localGuard, loopbackAddress } from "../src/local.js";
import { type RunningLocalStudio, type RunningStudio, start, startLocal } from "../src/start.js";
import { type Fixture, makeSite } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Hero
    fields:
      heading: { type: text, default: Hello }
collections:
  blog:
    path: content/blog
    format: markdown
    slug: title
    fields:
      title: { type: text, required: true }
`;

const POST_FILE = "content/blog/first-post.md";
const DRAFT_FILE = ".cms/draft/content/cms/home.hero.json";
const FORM = "application/x-www-form-urlencoded";

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

/** node:http rather than fetch: the tests need to say exactly what `Host` and `Origin` are. */
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

let site: Fixture;
let stateDir: string;
let studio: RunningLocalStudio | undefined;
let port: number;

async function open(overrides: Partial<Parameters<typeof startLocal>[0]> = {}) {
  port = await freePort();
  studio = await startLocal({ root: site.root, name: "My Site", stateDir, port, ...overrides });
  return studio;
}

const own = () => `http://127.0.0.1:${port}`;

/** A form post as the studio's own page sends it. */
const post = (path: string, body = "", headers: Record<string, string> = {}) =>
  send(port, path, {
    method: "POST",
    headers: { origin: own(), "content-type": FORM, ...headers },
    body,
  });

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
  site.commit(POST_FILE, "---\ntitle: First post\n---\n\nBody.\n");
  stateDir = mkdtempSync(join(tmpdir(), "greatcms-state-"));
});

afterEach(async () => {
  await studio?.close();
  studio = undefined;
  site.store.close();
  site.cleanup();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("nobody signs in", () => {
  it("opens the site and its editor for a browser that has never been here", async () => {
    const running = await open();
    expect(running.url).toBe(`http://127.0.0.1:${port}/sites/my-site`);
    expect(running).not.toHaveProperty("signInUrl");

    const page = await send(port, "/sites/my-site");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Hero");
    // Nothing for the browser to keep: the next request is the owner's for the same reason.
    expect(page.headers["set-cookie"]).toBeUndefined();

    const editor = await send(port, "/sites/my-site/regions/home.hero");
    expect(editor.status).toBe(200);
    expect(editor.body).toContain('name="f[heading]"');
  });

  it("publishes from the studio's own page with no cookie at all", async () => {
    await open();
    const before = site.head();
    const saved = await post(
      "/sites/my-site/regions/home.hero",
      new URLSearchParams({
        headSha: before,
        action: "publish",
        "f[heading]": "Changed",
      }).toString(),
    );
    expect(saved.status).toBeLessThan(400);
    expect(site.head()).not.toBe(before);
    expect(site.read("content/cms/home.hero.json")).toContain("Changed");
  });

  it("sends every sign-in address to the site, old link included", async () => {
    await open();
    for (const path of [
      "/sign-in",
      "/sign-in?next=%2Finbox",
      "/local/sign-in",
      "/local/sign-in?token=anything",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await send(port, path);
      expect(reply.status, path).toBe(303);
      expect(reply.headers.location, path).toBe("/sites/my-site");
      expect(reply.headers["set-cookie"], path).toBeUndefined();
      expect(reply.body, path).toBe("");
    }
  });

  it("takes no password, and has nothing to sign out of", async () => {
    await open();
    const password = await post("/sign-in", "password=anything");
    expect(password.status).toBe(303);
    expect(password.headers.location).toBe("/sites/my-site");
    expect(password.headers["set-cookie"]).toBeUndefined();

    const out = await post("/sign-out");
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe("/sites/my-site");
    expect(out.headers["set-cookie"]).toBeUndefined();
    expect((await send(port, "/sites/my-site")).status).toBe(200);
  });

  it("ignores whatever session a browser sends", async () => {
    await open();
    for (const cookie of [
      "greatcms_session=forged",
      "theme=dark; greatcms_session=editor%3A1.x.9999999999999.sig; greatcms_session=again",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const page = await send(port, "/sites/my-site", { headers: { cookie } });
      expect(page.status, cookie).toBe(200);
      expect(page.headers["set-cookie"], cookie).toBeUndefined();
    }
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
      const reply = await send(port, "/sites/my-site", { headers: { host } });
      expect(reply.status, host).toBe(403);
      expect(reply.body, host).not.toContain("Hero");
      expect(reply.headers["set-cookie"], host).toBeUndefined();
    }
  });

  it("refuses the right name on the wrong port", async () => {
    await open();
    for (const host of [`127.0.0.1:${port + 1}`, "127.0.0.1", "localhost:80"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      expect((await send(port, "/", { headers: { host } })).status, host).toBe(403);
    }
  });

  it("refuses a rebound name that posts from its own pages", async () => {
    await open();
    const before = site.head();
    const host = `rebound.example:${port}`;
    const reply = await send(port, "/sites/my-site/regions/home.hero", {
      method: "POST",
      headers: {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
        "content-type": FORM,
      },
      body: `headSha=${before}&action=publish&f[heading]=Rebound`,
    });
    expect(reply.status).toBe(403);
    expect(site.head()).toBe(before);
  });

  it("sends localhost to the one address the studio lives on, and only for page loads", async () => {
    await open();
    const load = await send(port, "/sites/my-site?x=1", { headers: { host: `localhost:${port}` } });
    expect(load.status).toBe(307);
    expect(load.headers.location).toBe(`http://127.0.0.1:${port}/sites/my-site?x=1`);
    expect(load.body).toBe("");

    const posted = await send(port, "/theme", {
      method: "POST",
      headers: {
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
        "content-type": FORM,
      },
      body: "theme=dark",
    });
    expect(posted.status).toBe(403);
    expect(posted.headers["set-cookie"]).toBeUndefined();
  });

  it("lets nothing through to the app when the header is missing", async () => {
    let reached = false;
    const guarded = localGuard(
      () => {
        reached = true;
        return new Response("app");
      },
      { port: 4983, urlHost: "127.0.0.1", signingKey: "k", landing: "/" },
    );
    const reply = await guarded(new Request("http://127.0.0.1:4983/"));
    expect(reply.status).toBe(403);
    expect(reached).toBe(false);
  });
});

/** What a browser says about a request another page made, in every form it takes. */
const FOREIGN: Array<[string, (port: number) => Record<string, string>]> = [
  ["another site", () => ({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })],
  ["another site, older browser", () => ({ origin: "https://evil.example" })],
  ["another port on this machine", (p) => ({ origin: `http://127.0.0.1:${p + 1}` })],
  ["this machine by another name", (p) => ({ origin: `http://localhost:${p}` })],
  ["a sandboxed frame", () => ({ origin: "null" })],
  ["cross-site with no Origin", () => ({ "sec-fetch-site": "cross-site" })],
  ["same-site with no Origin", () => ({ "sec-fetch-site": "same-site" })],
  [
    "same-site, own Origin",
    (p) => ({ origin: `http://127.0.0.1:${p}`, "sec-fetch-site": "same-site" }),
  ],
  [
    "cross-site, own Origin",
    (p) => ({ origin: `http://127.0.0.1:${p}`, "sec-fetch-site": "cross-site" }),
  ],
  ["typed into the address bar", () => ({ "sec-fetch-site": "none" })],
  ["a Referer and nothing else", (p) => ({ referer: `http://127.0.0.1:${p}/sites/my-site` })],
  ["nothing at all", () => ({})],
];

const publish = (head: string) =>
  new URLSearchParams({ headSha: head, action: "publish", "f[heading]": "Forged" }).toString();

describe("a web page in the same browser cannot act as the owner", () => {
  /** Every kind of change the studio makes, and how to tell it did not happen. */
  const CHANGES: Array<{ name: string; path: string; body: (head: string) => string }> = [
    { name: "publish", path: "/sites/my-site/regions/home.hero", body: publish },
    {
      name: "publish an entry",
      path: "/sites/my-site/collections/blog/first-post",
      body: (head) =>
        new URLSearchParams({ headSha: head, action: "publish", "f[title]": "Forged" }).toString(),
    },
    {
      name: "settings",
      path: "/sites/my-site/settings",
      body: () => "name=Forged&devUrl=http%3A%2F%2Fevil.example",
    },
    { name: "delete", path: "/sites/my-site/collections/blog/first-post/delete", body: () => "" },
    {
      name: "draft",
      path: "/sites/my-site/regions/home.hero/draft",
      body: () => "f[heading]=Forged",
    },
    {
      name: "entry draft",
      path: "/sites/my-site/collections/blog/first-post/draft",
      body: () => "f[title]=Forged",
    },
    {
      name: "discard a draft",
      path: "/sites/my-site/regions/home.hero/draft/discard",
      body: () => "",
    },
    { name: "push", path: "/sites/my-site/push", body: () => "" },
    { name: "theme", path: "/theme", body: () => "theme=dark" },
    { name: "sign out", path: "/sign-out", body: () => "" },
  ];

  it.each(FOREIGN)("refuses every change from %s", async (_name, headersFor) => {
    await open();
    // A real draft, so a forged discard has something to throw away.
    expect((await post("/sites/my-site/regions/home.hero/draft", "f[heading]=Mine")).status).toBe(
      204,
    );
    const draft = site.read(DRAFT_FILE);
    const head = site.head();

    for (const change of CHANGES) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await send(port, change.path, {
        method: "POST",
        headers: { "content-type": FORM, ...headersFor(port) },
        body: change.body(head),
      });
      expect(reply.status, change.name).toBe(403);
      expect(reply.headers["set-cookie"], change.name).toBeUndefined();
    }

    expect(site.head()).toBe(head);
    expect(site.exists("content/cms/home.hero.json")).toBe(false);
    expect(site.read(POST_FILE)).toContain("First post");
    expect(site.read(DRAFT_FILE)).toBe(draft);
    expect(site.exists(".cms/draft/content/blog/first-post.md")).toBe(false);
    const settings = await send(port, "/sites/my-site/settings");
    expect(settings.body).toContain('value="My Site"');
    expect(settings.body).not.toContain("evil.example");
  });

  it("refuses other methods the same way", async () => {
    await open();
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await send(port, "/sites/my-site/regions/home.hero", {
        method,
        headers: { origin: "https://evil.example" },
      });
      expect(reply.status, method).toBe(403);
    }
  });

  it.each([
    ["its Origin", (p: number) => ({ origin: `http://127.0.0.1:${p}` })],
    [
      "its Origin and Sec-Fetch-Site",
      (p: number) => ({ origin: `http://127.0.0.1:${p}`, "sec-fetch-site": "same-origin" }),
    ],
    ["Sec-Fetch-Site alone", () => ({ "sec-fetch-site": "same-origin" })],
  ])("lets the studio's own page through by %s", async (_name, headersFor) => {
    await open();
    const reply = await send(port, "/sites/my-site/regions/home.hero/draft", {
      method: "POST",
      headers: { "content-type": FORM, ...headersFor(port) },
      body: "f[heading]=Mine",
    });
    expect(reply.status).toBe(204);
    expect(site.read(DRAFT_FILE)).toContain("Mine");
  });

  it("still takes a site's own form from the site's address", async () => {
    await open();
    const reply = await send(port, "/f/my-site/contact", {
      method: "POST",
      headers: { origin: "http://localhost:4321", "content-type": FORM },
      body: "name=Ann",
    });
    // No such form in this schema: the app answered, not the guard.
    expect(reply.status).not.toBe(403);
  });
});

/** Every row of every table, to tell whether anything was written. */
function rows(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return JSON.stringify(
      tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
    );
  } finally {
    db.close();
  }
}

describe("a page load changes nothing", () => {
  const LOADS = [
    "/",
    "/sites",
    "/sites/my-site",
    "/sites/my-site/regions/home.hero",
    "/sites/my-site/regions/home.hero/history",
    "/sites/my-site/collections/blog",
    "/sites/my-site/collections/blog/first-post",
    "/sites/my-site/collections/blog/first-post/history",
    "/sites/my-site/collections/blog/new",
    "/sites/my-site/settings",
    "/sites/my-site/search?q=first",
    "/sites/my-site/icon",
    "/sites/my-site/media/none.png",
    "/inbox",
    "/inbox.csv",
    "/auth/check",
    "/share?token=x&next=http%3A%2F%2Fevil.example%2F",
    "/sign-in?next=%2Finbox",
    "/local/sign-in?token=x",
    "/sign-out",
    // Addresses that change things when posted to.
    "/sites/my-site/push",
    "/sites/my-site/rollback",
    "/sites/my-site/share/stop",
    "/sites/my-site/regions/home.hero/draft",
    "/sites/my-site/regions/home.hero/draft/discard",
    "/sites/my-site/collections/blog/first-post/delete",
    "/sites/my-site/delete",
    "/theme?theme=dark",
  ];

  it.each([
    ["GET", "the page itself"],
    ["GET", "an image on another site"],
    ["HEAD", "the page itself"],
  ])("%s as %s leaves the site, the drafts and the database as they were", async (method, from) => {
    await open();
    await post("/sites/my-site/regions/home.hero/draft", "f[heading]=Mine");
    const database = join(stateDir, "studio.sqlite");
    const before = { head: site.head(), draft: site.read(DRAFT_FILE), rows: rows(database) };
    const headers: Record<string, string> =
      from === "the page itself"
        ? {}
        : {
            "sec-fetch-site": "cross-site",
            "sec-fetch-dest": "image",
            referer: "https://evil.example/",
          };

    for (const path of LOADS) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await send(port, path, { method, headers });
      expect(reply.status, path).toBeLessThan(500);
      // A notice shown once is cleared; nothing else is ever set by a page load.
      expect(String(reply.headers["set-cookie"] ?? ""), path).not.toMatch(/session|preview|share/);
    }

    expect(site.head()).toBe(before.head);
    expect(site.read(DRAFT_FILE)).toBe(before.draft);
    expect(site.read(POST_FILE)).toContain("First post");
    expect(rows(database)).toBe(before.rows);
    site.git(["add", "-A"]);
    site.git(["diff", "--cached", "--quiet"]);
  });
});

describe("no other origin can read an answer", () => {
  it("never says another origin may, on a page, a file, a refusal or a preflight", async () => {
    await open();
    const asked: Array<[string, { method?: string; headers: Record<string, string> }]> = [];
    for (const origin of ["https://evil.example", `http://localhost:${port}`, "null"]) {
      const headers = { origin, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" };
      for (const path of [
        "/",
        "/sites/my-site",
        "/sites/my-site/regions/home.hero",
        "/sites/my-site/search?q=first",
        "/inbox.csv",
        "/assets/studio.css",
        "/favicon.svg",
        "/auth/check",
        "/sign-in",
        "/no-such-page",
      ]) {
        asked.push([path, { headers }]);
      }
      asked.push([
        "/sites/my-site/regions/home.hero",
        {
          method: "OPTIONS",
          headers: {
            ...headers,
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        },
      ]);
      asked.push(["/sites/my-site/regions/home.hero/draft", { method: "POST", headers }]);
      asked.push(["/sites/my-site", { headers: { ...headers, host: `evil.example:${port}` } }]);
    }

    for (const [path, options] of asked) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await send(port, path, options);
      const named = Object.keys(reply.headers).filter(
        (name) => name.startsWith("access-control-") || name === "timing-allow-origin",
      );
      expect(named, `${options.method ?? "GET"} ${path}`).toEqual([]);
      if (options.method) expect(reply.status, `${options.method} ${path}`).toBe(403);
    }
  });

  it("keeps the studio's own headers on its pages", async () => {
    await open();
    const page = await send(port, "/sites/my-site");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-store");
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

  it("with a password, signs nobody in by itself and asks for the password instead", async () => {
    await open({ host: "0.0.0.0", password: "a long test password" });
    for (const path of ["/", "/sites/my-site", "/local/sign-in", "/local/sign-in?token=anything"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await send(port, path);
      expect(reply.status, path).toBe(303);
      expect(reply.headers.location, path).toMatch(/^\/sign-in/);
      expect(reply.headers["set-cookie"], path).toBeUndefined();
      expect(reply.body, path).not.toContain("Hero");
    }
    const unsigned = await post("/sites/my-site/regions/home.hero/draft", "f[heading]=Forged");
    expect(unsigned.status).toBe(401);
    expect(site.exists(DRAFT_FILE)).toBe(false);

    const form = await send(port, "/sign-in");
    expect(form.status).toBe(200);
    expect(form.body).toContain("<form");

    const wrong = await post("/sign-in", "password=not+it");
    expect(wrong.status).toBe(401);
    const signedIn = await post("/sign-in", "password=a+long+test+password");
    expect(signedIn.status).toBe(303);
    const cookie = String(signedIn.headers["set-cookie"]).split(";")[0] as string;
    expect((await send(port, "/sites/my-site", { headers: { cookie } })).status).toBe(200);

    // Signing out is real here: the same cookie stops working.
    expect((await post("/sign-out", "", { cookie })).headers.location).toBe("/sign-in");
    expect((await send(port, "/sites/my-site", { headers: { cookie } })).status).toBe(303);
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

describe("a studio started the usual way", () => {
  let server: RunningStudio | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("has none of this, on loopback or not: it asks for its password", async () => {
    port = await freePort();
    server = await start({
      password: "a long test password",
      databaseFile: join(stateDir, "studio.sqlite"),
      port,
      hostname: "127.0.0.1",
      sites: [
        {
          id: "my-site",
          path: site.root,
          name: "My Site",
          devUrl: "",
          probeUrl: "",
          pushAfterPublish: false,
          deployRoot: "",
        },
      ],
    });

    for (const path of ["/", "/sites/my-site", "/local/sign-in", "/local/sign-in?token=anything"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await send(port, path);
      expect(reply.status, path).toBe(303);
      expect(reply.headers.location, path).toMatch(/^\/sign-in/);
      expect(reply.headers["set-cookie"], path).toBeUndefined();
    }
    expect((await send(port, "/sign-in")).body).toContain('type="password"');
    const unsigned = await post("/sites/my-site/regions/home.hero/draft", "f[heading]=Forged");
    expect(unsigned.status).toBe(401);
    expect(site.exists(DRAFT_FILE)).toBe(false);
  });
});

describe("state", () => {
  it("keeps the secret private, and the same across a restart", async () => {
    await open();
    const secret = join(stateDir, "secret");
    if (process.platform !== "win32") expect(statSync(secret).mode & 0o777).toBe(0o600);
    const before = readFileSync(secret, "utf8");

    await studio!.close();
    await open();
    expect(readFileSync(secret, "utf8")).toBe(before);
    expect((await send(port, "/sites/my-site")).status).toBe(200);
  });

  it("is one project: home is the site, and the screens for other sites and people are not there", async () => {
    await open();
    const home = await send(port, "/");
    expect(home.headers.location).toBe("/sites/my-site");
    for (const path of ["/sites/new", "/editors", "/git-access", "/sites/clone"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      expect((await send(port, path)).status, path).toBe(404);
    }
  });

  it("keeps what was changed in the site's settings, and takes a new dev URL from the command", async () => {
    await open({ devUrl: "http://localhost:4321" });
    const saved = await post(
      "/sites/my-site/settings",
      "name=Renamed&devUrl=http%3A%2F%2Flocalhost%3A4400",
    );
    expect(saved.status).toBeLessThan(400);

    await studio!.close();
    await open();
    let page = await send(port, "/sites/my-site/settings");
    expect(page.body).toContain('value="Renamed"');
    expect(page.body).toContain("http://localhost:4400");

    await studio!.close();
    await open({ devUrl: "http://localhost:4322" });
    page = await send(port, "/sites/my-site/settings");
    expect(page.body).toContain("http://localhost:4322");
  });

  it("follows the folder when the cache remembers another one", async () => {
    await open();
    await studio!.close();
    const moved = makeSite({ schema: SCHEMA });
    try {
      port = await freePort();
      studio = await startLocal({ root: moved.root, name: "My Site", stateDir, port });
      expect((await send(port, "/sites/my-site")).status).toBe(200);
    } finally {
      await studio?.close();
      studio = undefined;
      moved.store.close();
      moved.cleanup();
    }
  });
});

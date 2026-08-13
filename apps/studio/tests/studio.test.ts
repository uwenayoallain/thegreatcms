/**
 * End-to-end tests for the studio, driven through `app.request` with a fake
 * GitHub behind it. No network, no browser, no server — the whole publish path
 * runs in milliseconds, which is what makes it worth running on every save.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR } from "@greatcms/conformance";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createSessionCookie } from "../src/auth.js";
import { Store } from "../src/db.js";

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

interface Committed {
  message: string;
  files: Array<{ path: string; content: string }>;
}

/** A fake GitHub holding the conformance fixture site in memory. */
function fakeGitHub() {
  const files = new Map<string, string>([
    [".cms/schema.yaml", fixture(".cms/schema.yaml")],
    [".cms/config.yaml", fixture(".cms/config.yaml")],
    ["content/cms/home.hero.json", fixture("content/cms/home.hero.json")],
    ["content/cms/home.body.json", fixture("content/cms/home.body.json")],
  ]);
  const commits: Committed[] = [];
  const refUpdates: Array<{ branch: string }> = [];
  const pulls: Array<{
    number: number;
    url: string;
    title: string;
    base?: string;
    head?: string;
    body?: string;
  }> = [];
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
    if (method === "GET" && pathname.includes("/git/commits/")) {
      return json({ tree: { sha: "tree-1" } });
    }
    if (method === "POST" && pathname.endsWith("/git/blobs")) {
      const sha = `blob-${state.blobs.size + 1}`;
      state.blobs.set(sha, String(body.content));
      return json({ sha });
    }
    if (method === "POST" && pathname.endsWith("/git/trees")) {
      const pending = (body.tree as Array<{ path: string; sha: string }>).map((entry) => ({
        path: entry.path,
        content: state.blobs.get(entry.sha) ?? "",
      }));
      commits.push({ message: "", files: pending });
      for (const file of pending) files.set(file.path, file.content);
      return json({ sha: "tree-2" });
    }
    if (method === "POST" && pathname.endsWith("/git/commits")) {
      const last = commits.at(-1);
      if (last) last.message = String(body.message);
      state.head = `commit-${commits.length + 1}`;
      return json({ sha: state.head, html_url: `https://gh/${state.head}` });
    }
    if (method === "GET" && pathname.endsWith("/pulls")) {
      return json(pulls.map((pr) => ({ number: pr.number, html_url: pr.url, title: pr.title })));
    }
    if (method === "POST" && pathname.endsWith("/pulls")) {
      const pr = {
        number: pulls.length + 1,
        url: `https://gh/pr/${pulls.length + 1}`,
        title: String(body.title),
        base: String(body.base),
        head: String(body.head),
        body: String(body.body),
      };
      pulls.push(pr);
      return json({ number: pr.number, html_url: pr.url, title: pr.title });
    }
    if (method === "PATCH" && pathname.includes("/pulls/")) {
      const pr = pulls[0];
      if (pr) {
        pr.title = String(body.title);
        pr.body = String(body.body);
      }
      return json({ number: pr?.number, html_url: pr?.url, title: pr?.title });
    }
    if (method === "PATCH" && pathname.includes("/git/refs/heads/")) {
      refUpdates.push({ branch: pathname.split("/git/refs/heads/")[1] ?? "" });
      return json({ ok: true });
    }
    if (method === "POST" && pathname.endsWith("/git/refs")) {
      return json({ ref: String(body.ref) });
    }
    return json({ message: `unhandled ${method} ${pathname}` }, 500);
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, commits, refUpdates, pulls, files, state };
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

const signedIn = { cookie: createSessionCookie(SECRET).split(";")[0] as string };

function get(path: string, headers: Record<string, string> = signedIn) {
  return app.request(path, { headers });
}

function post(path: string, fields: Record<string, string>, headers = signedIn) {
  const body = new URLSearchParams(fields);
  return app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("access", () => {
  it("sends anonymous visitors to sign in", async () => {
    const response = await get("/", {});
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("refuses a wrong password without hinting why", async () => {
    const response = await post("/sign-in", { password: "guess" }, {});
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("That password did not work");
  });

  it("issues an HttpOnly session cookie on success", async () => {
    const response = await post("/sign-in", { password: PASSWORD }, {});
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("refuses cross-origin posts", async () => {
    const response = await post(
      "/sites/site-1/regions/home.hero",
      {},
      {
        ...signedIn,
        origin: "https://evil.example",
        host: "studio.local",
      },
    );
    expect(response.status).toBe(403);
  });

  it("rejects a tampered session cookie", async () => {
    const tampered = `${createSessionCookie(SECRET).split(";")[0]}tampered`;
    const response = await get("/", { cookie: tampered });
    expect(response.status).toBe(303);
  });
});

describe("editing a region", () => {
  it("renders a form built from the schema, filled with current content", async () => {
    const response = await get("/sites/site-1/regions/home.hero");
    expect(response.status).toBe(200);
    const { document } = new JSDOM(await response.text()).window;

    const heading = document.querySelector<HTMLInputElement>('input[name="f[heading]"]');
    expect(heading?.value).toBe("Publish from anywhere");
    expect(document.querySelector(`label[for="${heading?.id}"]`)?.textContent).toContain("Heading");
    // Head sha travels with the form so a concurrent change can be detected.
    expect(document.querySelector<HTMLInputElement>('input[name="headSha"]')?.value).toBe("head-1");
  });

  it("shows schema defaults for a region nobody has edited", async () => {
    const response = await get("/sites/site-1/regions/about.intro");
    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelector<HTMLInputElement>('input[name="f[heading]"]')?.value).toBe(
      "About us",
    );
  });

  it("publishes one commit and reports it", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      action: "publish",
      "f[heading]": "Edited in the studio",
      "f[subtitle]": "Still one commit",
      "f[image][src]": "/media/hero.webp",
      "f[image][alt]": "A person editing a page",
      "f[cta][href]": "/get-started",
      "f[cta][label]": "Get started",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Published as");

    expect(github.commits).toHaveLength(1);
    const commit = github.commits[0];
    expect(commit?.files.map((f) => f.path)).toEqual(["content/cms/home.hero.json"]);
    expect(commit?.message).toBe("content: update home.hero");

    const written = JSON.parse(commit?.files[0]?.content ?? "{}");
    expect(written.heading).toBe("Edited in the studio");
    expect(written._meta.updatedBy).toBe("studio");
    // External-ness is derived, not typed by hand.
    expect(written.cta).toEqual({ href: "/get-started", label: "Get started" });
  });

  it("writes stable, diff-friendly JSON", async () => {
    await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      "f[heading]": "Ordering",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "Alt",
    });
    const content = github.commits[0]?.files[0]?.content ?? "";
    expect(content.endsWith("}\n")).toBe(true);
    const keys = Object.keys(JSON.parse(content));
    expect(keys).toEqual(
      [...keys].toSorted(
        (a, b) => Number(a.startsWith("_")) - Number(b.startsWith("_")) || a.localeCompare(b),
      ),
    );
  });

  it("refuses to publish invalid content, and says which field is wrong", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      "f[heading]": "",
    });

    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("Nothing was published");
    expect(github.commits).toHaveLength(0);

    const { document } = new JSDOM(body).window;
    const heading = document.querySelector('input[name="f[heading]"]');
    expect(heading?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = heading?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy.split(" ").at(-1) ?? "")?.textContent).toContain(
      "required",
    );
  });

  it("will not publish an image without alt text", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      "f[heading]": "Fine",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "",
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Alt text is empty");
    expect(github.commits).toHaveLength(0);
  });

  it("refuses to overwrite work committed while the editor was open", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "stale-sha",
      "f[heading]": "Mine",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "Alt",
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("moved while you were editing");
    expect(github.commits).toHaveLength(0);
  });

  it("keeps what the author typed when validation fails", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      "f[heading]": "",
      "f[subtitle]": "Typed but not saved",
    });
    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelector<HTMLInputElement>('input[name="f[subtitle]"]')?.value).toBe(
      "Typed but not saved",
    );
  });
});

describe("block lists", () => {
  it("renders each stored block with move and remove controls", async () => {
    const response = await get("/sites/site-1/regions/home.body");
    const { document } = new JSDOM(await response.text()).window;

    expect(document.querySelectorAll("section.block")).toHaveLength(4);
    expect(document.querySelector<HTMLButtonElement>('button[value="up:0"]')?.disabled).toBe(true);
    expect(document.querySelector('button[value="remove:1"]')).toBeTruthy();
  });

  it("adds a block without JavaScript, and without publishing", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
      headSha: "head-1",
      action: "add",
      addType: "text",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "Kept",
    });

    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelectorAll("section.block")).toHaveLength(2);
    expect(github.commits).toHaveLength(0);
  });

  it("reorders blocks on the server", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
      headSha: "head-1",
      action: "down:0",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "First",
      "f[blocks][1][_type]": "text",
      "f[blocks][1][body]": "<p>Second</p>",
    });

    const { document } = new JSDOM(await response.text()).window;
    const headings = [...document.querySelectorAll("section.block h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Text", "Hero"]);
  });

  it("ignores a block type the schema does not allow", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
      headSha: "head-1",
      action: "add",
      addType: "malicious",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "Kept",
    });
    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelectorAll("section.block")).toHaveLength(1);
  });

  it("publishes a block list as a blocks document", async () => {
    await post("/sites/site-1/regions/home.body", {
      headSha: "head-1",
      action: "publish",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "Only block",
    });

    const written = JSON.parse(github.commits[0]?.files[0]?.content ?? "{}");
    expect(written.blocks).toEqual([{ _type: "hero", heading: "Only block" }]);
  });
});

describe("connecting a site", () => {
  it("rejects a repository with no schema, before storing anything", async () => {
    const empty = (async () => json({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const isolated = createApp({
      store: new Store(":memory:"),
      password: PASSWORD,
      secret: SECRET,
      fetch: empty,
    });

    const response = await isolated.request("/sites", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Broken",
        owner: "ada",
        repo: "nope",
        branch: "main",
        token: "t",
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("no .cms/schema.yaml");
  });
});

describe("accessibility", () => {
  const pages = [
    ["sign in", "/sign-in"],
    ["sites", "/"],
    ["connect a site", "/sites/new"],
    ["site", "/sites/site-1"],
    ["edit a region", "/sites/site-1/regions/home.hero"],
    ["edit a block list", "/sites/site-1/regions/home.body"],
  ] as const;

  it.each(pages)("%s has no axe violations", async (_name, path) => {
    const response = await get(path, path === "/sign-in" ? {} : signedIn);
    const dom = new JSDOM(await response.text(), { url: "https://studio.test/" });
    const { window } = dom;
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });

    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });

  it("ships no JavaScript", async () => {
    const body = await (await get("/sites/site-1/regions/home.body")).text();
    expect(body).not.toMatch(/<script/i);
  });
});

describe("draft previews", () => {
  it("commits to a draft branch and leaves the publish branch alone", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      action: "draft",
      "f[heading]": "Not live yet",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "Alt",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Nothing on main has changed");
    expect(body).toContain("cms/draft-home.hero");

    // The commit went to the draft branch, never to main.
    expect(github.commits).toHaveLength(1);
    expect(github.refUpdates.map((ref) => ref.branch)).toEqual(["cms/draft-home.hero"]);
  });

  it("validates a draft too, because a preview of invalid content is useless", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      action: "draft",
      "f[heading]": "",
    });
    expect(response.status).toBe(422);
    expect(github.commits).toHaveLength(0);
  });

  it("explains how to get an inline preview when no URL template is configured", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      action: "draft",
      "f[heading]": "Draft",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "Alt",
    });
    expect(await response.text()).toContain("preview.urlTemplate");
  });

  it("treats draft as a save, not a block-list edit", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
      headSha: "head-1",
      action: "draft",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "Drafted",
    });
    expect(response.status).toBe(200);
    expect(github.commits).toHaveLength(1);
  });
});

describe("local preview", () => {
  it("hands you the exact command to preview the draft with your own dev server", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "head-1",
      action: "draft",
      "f[heading]": "Draft",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "Alt",
    });

    const body = await response.text();
    expect(body).toContain("npx greatcms preview --branch cms/draft-home.hero");
    expect(body).toContain("Your build runs on your machine");
  });
});

describe("publishing as a pull request", () => {
  const prSite = {
    ...SITE,
    id: "site-pr",
    name: "Reviewed",
    publishMode: "pull-request" as const,
  };

  function prApp(summarizer?: { summarize: () => Promise<never> } | undefined) {
    const prStore = new Store(":memory:");
    prStore.addSite(prSite);
    return {
      store: prStore,
      prApp: createApp({
        store: prStore,
        password: PASSWORD,
        secret: SECRET,
        fetch: github.fetchImpl,
        ...(summarizer ? { summarizer: summarizer as never } : {}),
      }),
    };
  }

  const propose = (target: ReturnType<typeof createApp>, fields: Record<string, string>) =>
    target.request("/sites/site-pr/regions/home.hero", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        headSha: "head-1",
        action: "publish",
        "f[image][src]": "/media/a.webp",
        "f[image][alt]": "Alt",
        ...fields,
      }),
    });

  it("opens a pull request instead of committing to the publish branch", async () => {
    const { prApp: underTest } = prApp();
    const response = await propose(underTest, { "f[heading]": "Proposed heading" });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Opened pull request #1");
    expect(body).toContain("Nothing is live until it is merged");

    // The commit went to the draft branch; main was never touched.
    expect(github.refUpdates.map((ref) => ref.branch)).toEqual(["cms/draft-home.hero"]);
    expect(github.pulls[0]).toMatchObject({ base: "main", head: "cms/draft-home.hero" });
  });

  it("names the pull request from the diff, with no model involved", async () => {
    const { prApp: underTest } = prApp();
    await propose(underTest, { "f[heading]": "Proposed heading" });

    const pr = github.pulls[0];
    expect(pr?.title).toContain("Home hero");
    expect(pr?.body).toContain("| `heading` |");
    expect(pr?.body).toContain("Merging this publishes the change");
  });

  it("updates the open pull request rather than opening a second one", async () => {
    const { prApp: underTest } = prApp();
    await propose(underTest, { "f[heading]": "First attempt" });
    const response = await propose(underTest, { "f[heading]": "Second attempt" });

    expect(await response.text()).toContain("Updated pull request #1");
    expect(github.pulls).toHaveLength(1);
  });

  it("records the pull request alongside the commit", async () => {
    const { prApp: underTest, store: prStore } = prApp();
    await propose(underTest, { "f[heading]": "Recorded" });

    const [entry] = prStore.recentPublishes("site-pr");
    expect(entry?.pull_request_url).toBe("https://gh/pr/1");
  });

  it("still refuses invalid content, before opening anything", async () => {
    const { prApp: underTest } = prApp();
    const response = await propose(underTest, { "f[heading]": "" });

    expect(response.status).toBe(422);
    expect(github.pulls).toHaveLength(0);
  });

  it("labels the publish button as proposing, so nobody expects it to go live", async () => {
    const { prApp: underTest } = prApp();
    const body = await (
      await underTest.request("/sites/site-pr/regions/home.hero", { headers: signedIn })
    ).text();
    expect(body).toContain("Propose change");
    expect(body).not.toContain(">Publish<");
  });

  it("does not send content to a model unless the site opted in", async () => {
    const summarize = vi.fn();
    const { prApp: underTest } = prApp({ summarize } as never);
    await propose(underTest, { "f[heading]": "Private content" });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("uses the model when the site opted in, and says so", async () => {
    const optedIn = new Store(":memory:");
    optedIn.addSite({ ...prSite, aiTitles: true });
    const optedInApp = createApp({
      store: optedIn,
      password: PASSWORD,
      secret: SECRET,
      fetch: github.fetchImpl,
      summarizer: {
        async summarize() {
          return { title: "Freshen up the homepage hero", body: "Body", fromModel: true };
        },
      },
    });

    const response = await optedInApp.request("/sites/site-pr/regions/home.hero", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        headSha: "head-1",
        "f[heading]": "Model named",
        "f[image][src]": "/media/a.webp",
        "f[image][alt]": "Alt",
      }),
    });

    const body = await response.text();
    expect(github.pulls[0]?.title).toBe("Freshen up the homepage hero");
    expect(body).toContain("Title written by the configured model");
  });
});

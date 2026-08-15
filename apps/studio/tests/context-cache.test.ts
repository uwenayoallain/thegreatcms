/** What a page view costs, and what it must never cost you in staleness. */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";
import { clearContextCache } from "../src/sites.js";

const PASSWORD = "cache-password";
const SECRET = "cache-secret";

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, default: Original }
`;

/** A GitHub that counts what it is asked for, and can move its head. */
function countingGitHub() {
  const files = new Map<string, string>([[".cms/schema.yaml", SCHEMA]]);
  const calls: string[] = [];
  const state = { head: "head-1" };

  const fetchImpl = (async (url: string | URL) => {
    const { pathname } = new URL(String(url));
    calls.push(pathname);

    if (pathname.includes("/git/ref/heads/")) {
      return json({ object: { sha: state.head } });
    }
    if (pathname.includes("/contents/")) {
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
    return json({});
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, calls, files, state };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const signedIn = {
  cookie: createSessionCookie(sessionKey(SECRET, PASSWORD)).split(";")[0] as string,
};

let github: ReturnType<typeof countingGitHub>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  clearContextCache();
  github = countingGitHub();
  const store = new Store(":memory:");
  store.addSite({
    id: "gh",
    name: "Remote",
    owner: "ada",
    repo: "site",
    branch: "main",
    token: "t",
    publishMode: "direct",
    aiTitles: false,
    createdAt: "2026-08-15",
  });
  app = createApp({ store, password: PASSWORD, secret: SECRET, fetch: github.fetchImpl });
});

const view = () => app.request("/sites/gh/regions/home.hero", { headers: signedIn });

describe("what a repeat page view costs", () => {
  it("asks GitHub once for the head and once for the content, not eight times", async () => {
    await view();
    github.calls.length = 0;

    await view();

    // Six of the eight were guesses at which spelling of the file name exists.
    expect(github.calls).toHaveLength(2);
    expect(github.calls.some((path) => path.includes("/git/ref/heads/"))).toBe(true);
    expect(github.calls.some((path) => path.includes("home.hero.json"))).toBe(true);
  });

  it("still checks the head every time, so it can tell when it is stale", async () => {
    await view();
    github.calls.length = 0;
    await view();

    expect(github.calls.filter((path) => path.includes("/git/ref/heads/"))).toHaveLength(1);
  });
});

describe("staleness", () => {
  it("re-reads the schema after a commit moves the branch", async () => {
    expect(await (await view()).text()).toContain("Original");

    github.files.set(".cms/schema.yaml", SCHEMA.replace("Original", "Rewritten"));
    github.state.head = "head-2";

    expect(await (await view()).text()).toContain("Rewritten");
  });

  it("does not re-read it while the branch has not moved", async () => {
    await view();

    // A schema change without a commit cannot happen on GitHub: every write is
    // one. If it could, this is the case that would be wrong.
    github.files.set(".cms/schema.yaml", SCHEMA.replace("Original", "Rewritten"));

    expect(await (await view()).text()).toContain("Original");
  });
});

describe("a folder on this machine", () => {
  let root: string;
  let local: ReturnType<typeof createApp>;

  beforeEach(() => {
    clearContextCache();
    root = mkdtempSync(join(tmpdir(), "greatcms-local-"));
    mkdirSync(join(root, ".cms"), { recursive: true });
    writeFileSync(join(root, ".cms/schema.yaml"), SCHEMA);

    const store = new Store(":memory:");
    store.addSite({
      id: "local",
      kind: "local",
      name: "On disk",
      path: root,
      owner: "",
      repo: "",
      branch: "main",
      token: "",
      publishMode: "direct",
      aiTitles: false,
      createdAt: "2026-08-15",
    });
    local = createApp({ store, password: PASSWORD, secret: SECRET });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sees a schema you edited by hand, which never moves HEAD", async () => {
    const page = () => local.request("/sites/local/regions/home.hero", { headers: signedIn });
    expect(await (await page()).text()).toContain("Original");

    writeFileSync(join(root, ".cms/schema.yaml"), SCHEMA.replace("Original", "Rewritten"));

    // The whole reason local sites are exempt from the cache: editing the
    // schema by hand is the normal way to work on one.
    expect(await (await page()).text()).toContain("Rewritten");
  });
});

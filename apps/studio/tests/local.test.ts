/** Local sites, driven against a real folder and a real Git repository. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";
import { LocalRepository } from "../src/repo.js";

const PASSWORD = "local-password";
const SECRET = "test-secret";

let root: string;
let store: Store;
let app: ReturnType<typeof createApp>;

const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
const signedIn = {
  cookie: createSessionCookie(sessionKey(SECRET, PASSWORD)).split(";")[0] as string,
};

function site(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-1",
    name: "On disk",
    path: root,
    devUrl: "http://localhost:4321",
    createdAt: "2026-08-13",
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-local-"));
  mkdirSync(join(root, ".cms"), { recursive: true });
  mkdirSync(join(root, "content/cms"), { recursive: true });

  writeFileSync(
    join(root, ".cms/schema.yaml"),
    `version: 1
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }
      subtitle: { type: text }
    default:
      heading: Welcome
`,
  );
  writeFileSync(join(root, ".cms/config.yaml"), "version: 1\n");

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);

  store = new Store(":memory:");
  store.addSite(site());
  app = createApp({ store, password: PASSWORD, secret: SECRET });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, fields: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

describe("editing a folder on this machine", () => {
  it("reads the schema straight off disk, with no token", async () => {
    const response = await app.request("/sites/local-1/regions/home.hero", { headers: signedIn });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Home hero");
  });

  it("writes the content file into the working copy", async () => {
    const response = await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      "f[heading]": "Written to disk",
      "f[subtitle]": "No network involved",
    });

    expect(response.status).toBe(200);

    const written = JSON.parse(readFileSync(join(root, "content/cms/home.hero.json"), "utf8"));
    expect(written.heading).toBe("Written to disk");
    expect(written.subtitle).toBe("No network involved");
  });

  it("commits, so a local site still has history", async () => {
    await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      "f[heading]": "Committed locally",
    });

    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: root, encoding: "utf8" });
    expect(log).toContain("content: update home.hero");

    // Nothing left dangling in the working copy.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(status.trim()).toBe("");
  });

  it("shows the running dev server beside the editor", async () => {
    const body = await (
      await app.request("/sites/local-1/regions/home.hero", { headers: signedIn })
    ).text();

    expect(body).toContain('src="http://localhost:4321"');
    expect(body).toContain("Your real components");
  });
});

/** The live loop: what you type is written where the site's dev server reads it, and nowhere else. */
describe("editing live, before anything is published", () => {
  const draftFile = () => join(root, ".cms/draft/content/cms/home.hero.json");

  it("writes what is in the form to the draft directory", async () => {
    const response = await post("/sites/local-1/regions/home.hero/draft", {
      "f[heading]": "Halfway through a sentence",
    });

    expect(response.status).toBe(204);
    expect(JSON.parse(readFileSync(draftFile(), "utf8")).heading).toBe(
      "Halfway through a sentence",
    );
  });

  it("leaves the published content alone", async () => {
    await post("/sites/local-1/regions/home.hero", { headSha: "", "f[heading]": "Published" });
    await post("/sites/local-1/regions/home.hero/draft", { "f[heading]": "Only a draft" });

    const published = JSON.parse(readFileSync(join(root, "content/cms/home.hero.json"), "utf8"));
    expect(published.heading).toBe("Published");
  });

  it("clears the draft once the same content is published", async () => {
    await post("/sites/local-1/regions/home.hero/draft", { "f[heading]": "About to publish" });
    expect(existsSync(draftFile())).toBe(true);

    await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      "f[heading]": "About to publish",
    });

    expect(existsSync(draftFile())).toBe(false);
  });

  it("keeps drafts out of Git, so one can never be committed by accident", async () => {
    await post("/sites/local-1/regions/home.hero/draft", { "f[heading]": "Never committed" });

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(status.trim()).toBe("");
    expect(readFileSync(join(root, ".cms/draft/.gitignore"), "utf8")).toBe("*\n");
  });

  it("offers one way to publish, because there is only one place to publish to", async () => {
    const body = await (
      await app.request("/sites/local-1/regions/home.hero", { headers: signedIn })
    ).text();

    // Draft branches and pull requests were the GitHub story. What replaced
    // them for a working copy is the live draft below, which never commits.
    expect(body).not.toContain("Save draft");
    expect(body).not.toContain("Propose change");
    expect(body).toContain("Publish");
  });

  it("shows an unsaved edit in the site without committing it", async () => {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });

    const response = await post("/sites/local-1/regions/home.hero/draft", {
      "f[heading]": "Meant as a preview",
    });

    expect(response.status).toBe(204);
    expect(readFileSync(join(root, ".cms/draft/content/cms/home.hero.json"), "utf8")).toContain(
      "Meant as a preview",
    );
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).toBe(
      before,
    );
  });

  it("lists what is unsaved on the site page, so none is forgotten", async () => {
    await post("/sites/local-1/regions/home.hero/draft", { "f[heading]": "Left half-written" });

    const body = await (await app.request("/sites/local-1", { headers: signedIn })).text();
    expect(body).toContain("Unsaved edits");
    expect(body).toContain("content/cms/home.hero.json");
    expect(body).toContain("/sites/local-1/regions/home.hero");
  });

  it("discards one with a plain form post, no JavaScript involved", async () => {
    await post("/sites/local-1/regions/home.hero/draft", { "f[heading]": "Never mind" });
    expect(existsSync(draftFile())).toBe(true);

    const response = await post("/sites/local-1/regions/home.hero/draft/discard", {});
    expect(response.status).toBe(303);
    expect(existsSync(draftFile())).toBe(false);

    const body = await (await app.request("/sites/local-1", { headers: signedIn })).text();
    expect(body).not.toContain("Unsaved edits");
  });

  it("points the editor's frame at the endpoint that writes them", async () => {
    const body = await (
      await app.request("/sites/local-1/regions/home.hero", { headers: signedIn })
    ).text();

    expect(body).toContain('data-live-site="/sites/local-1/regions/home.hero/draft"');
  });

  it("still refuses invalid content, and writes nothing", async () => {
    const response = await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      "f[heading]": "",
    });

    expect(response.status).toBe(422);
    expect(existsSync(join(root, "content/cms/home.hero.json"))).toBe(false);
  });

  it("reports a folder with no schema in terms of the folder", async () => {
    const empty = mkdtempSync(join(tmpdir(), "greatcms-empty-"));
    const emptyStore = new Store(":memory:");
    emptyStore.addSite(site({ id: "empty-1", path: empty }));
    const emptyApp = createApp({ store: emptyStore, password: PASSWORD, secret: SECRET });

    const response = await emptyApp.request("/sites/empty-1", { headers: signedIn });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("no .cms/schema.yaml");

    rmSync(empty, { recursive: true, force: true });
  });
});

describe("LocalRepository", () => {
  it("refuses a path that climbs out of the site", async () => {
    const repo = new LocalRepository(root);
    await expect(
      repo.commitFiles({
        branch: "main",
        message: "escape",
        files: [{ path: "../../etc/greatcms-escape", content: "no" }],
      }),
    ).rejects.toThrow(/resolves outside/);
  });

  it("works in a folder that is not a Git repository at all", async () => {
    const plain = mkdtempSync(join(tmpdir(), "greatcms-plain-"));
    const repo = new LocalRepository(plain);

    const result = await repo.commitFiles({
      branch: "main",
      message: "no git here",
      files: [{ path: "content/cms/a.json", content: '{"x":1}\n' }],
    });

    expect(result.commitSha).toBe("working-copy");
    expect(readFileSync(join(plain, "content/cms/a.json"), "utf8")).toBe('{"x":1}\n');

    rmSync(plain, { recursive: true, force: true });
  });

  it("writes binary uploads intact", async () => {
    const repo = new LocalRepository(root);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await repo.commitFiles({
      branch: "main",
      message: "upload",
      files: [{ path: "public/media/a.png", base64: bytes.toString("base64") }],
    });

    expect(readFileSync(join(root, "public/media/a.png"))).toEqual(bytes);
  });

  it("deletes a file when asked", async () => {
    const repo = new LocalRepository(root);
    writeFileSync(join(root, "content/cms/old.json"), "{}");

    await repo.commitFiles({
      branch: "main",
      message: "remove",
      files: [{ path: "content/cms/old.json", delete: true }],
    });

    expect(existsSync(join(root, "content/cms/old.json"))).toBe(false);
  });

  it("refuses to publish over a commit made while the editor was open", async () => {
    const repo = new LocalRepository(root);
    await expect(
      repo.commitFiles({
        branch: "main",
        message: "stale",
        files: [{ path: "content/cms/a.json", content: "{}" }],
        expectedHeadSha: "a-commit-that-is-not-head",
      }),
    ).rejects.toThrow(/moved while you were editing/);
  });
});

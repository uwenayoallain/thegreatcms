/** Local sites, driven against a real folder and a real Git repository. */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("refuses to publish a draft over a change published after it began", async () => {
    const started = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    await post("/sites/local-1/regions/home.hero/draft", {
      headSha: started,
      "f[heading]": "My draft, from before",
    });

    // Someone else publishes the same region meanwhile.
    writeFileSync(join(root, "content/cms/home.hero.json"), '{ "heading": "Theirs" }\n');
    git(["add", "-A"]);
    git(["commit", "-qm", "their publish"]);

    const editor = await (
      await app.request("/sites/local-1/regions/home.hero", { headers: signedIn })
    ).text();
    expect(editor).toContain("Someone published this since your unsaved edits began");
    expect(editor).toContain(`name="headSha" value="${started}"`);

    const publish = await post("/sites/local-1/regions/home.hero", {
      headSha: started,
      "f[heading]": "My draft, from before",
    });
    expect(publish.status).toBe(409);
    expect(JSON.parse(readFileSync(join(root, "content/cms/home.hero.json"), "utf8")).heading).toBe(
      "Theirs",
    );
  });

  it("restores a draft without alarm when nothing changed under it", async () => {
    const started = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    await post("/sites/local-1/regions/home.hero/draft", {
      headSha: started,
      "f[heading]": "Mine",
    });
    writeFileSync(join(root, "unrelated.txt"), "x\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "unrelated"]);

    const editor = await (
      await app.request("/sites/local-1/regions/home.hero", { headers: signedIn })
    ).text();
    expect(editor).toContain("Unsaved edits restored");
    expect(editor).not.toContain("Someone published this");
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

  const headSha = () =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const failingHook = (path: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(
      join(root, path),
      '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/hook-ran"\nexit 1\n',
    );
    chmodSync(join(root, path), 0o755);
  };

  it("reports a commit git refused, instead of calling it published", async () => {
    const repo = new LocalRepository(root);
    writeFileSync(join(root, ".git/index.lock"), "");

    await expect(
      repo.commitFiles({
        message: "locked",
        files: [{ path: "content/cms/a.json", content: "{}" }],
      }),
    ).rejects.toThrow(/git add failed/);
  });

  it("does not run the site's git hooks", async () => {
    const repo = new LocalRepository(root);
    const before = headSha();
    failingHook(".git/hooks/pre-commit");

    await repo.commitFiles({
      message: "hooked",
      files: [{ path: "content/cms/a.json", content: "{}" }],
    });

    expect(headSha()).not.toBe(before);
    expect(existsSync(join(root, "hook-ran"))).toBe(false);
  });

  it("does not run hooks from a committed hooks folder either", async () => {
    const repo = new LocalRepository(root);
    const before = headSha();
    failingHook(".husky/pre-commit");
    git(["config", "core.hooksPath", ".husky"]);

    await repo.commitFiles({
      message: "hooked",
      files: [{ path: "content/cms/a.json", content: "{}" }],
    });

    expect(headSha()).not.toBe(before);
    expect(existsSync(join(root, "hook-ran"))).toBe(false);
  });

  it("refuses to write through a folder that links outside the site", async () => {
    const outside = mkdtempSync(join(tmpdir(), "greatcms-outside-"));
    symlinkSync(outside, join(root, "content/linked"));
    const repo = new LocalRepository(root);

    await expect(
      repo.commitFiles({
        message: "escape",
        files: [{ path: "content/linked/a.json", content: "{}" }],
      }),
    ).rejects.toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses to overwrite a file that is a link to somewhere else", async () => {
    const outside = mkdtempSync(join(tmpdir(), "greatcms-outside-"));
    writeFileSync(join(outside, "secret.txt"), "keep me");
    symlinkSync(join(outside, "secret.txt"), join(root, "content/cms/a.json"));
    const repo = new LocalRepository(root);

    await expect(
      repo.commitFiles({ message: "x", files: [{ path: "content/cms/a.json", content: "{}" }] }),
    ).rejects.toThrow(/symbolic link/);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("keep me");
    rmSync(outside, { recursive: true, force: true });
  });

  it("never reads a file that a link points outside the site, so a commit cannot expose one", async () => {
    const outside = mkdtempSync(join(tmpdir(), "greatcms-outside-"));
    writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY");
    symlinkSync(join(outside, "id_rsa"), join(root, "content/cms/leak.json"));
    const repo = new LocalRepository(root);

    expect(await repo.getFile("content/cms/leak.json")).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it("publishes one at a time, so two at once both land as commits", async () => {
    const repo = new LocalRepository(root);
    const before = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }),
    );

    await Promise.all([
      repo.commitFiles({ message: "a", files: [{ path: "content/cms/a.json", content: "{}" }] }),
      repo.commitFiles({ message: "b", files: [{ path: "content/cms/b.json", content: "{}" }] }),
      new LocalRepository(root).commitFiles({
        message: "c",
        files: [{ path: "content/cms/c.json", content: "{}" }],
      }),
    ]);

    const after = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }),
    );
    expect(after - before).toBe(3);
  });

  it("leaves no temporary files behind", async () => {
    const repo = new LocalRepository(root);
    await repo.commitFiles({
      message: "x",
      files: [
        { path: "content/cms/a.json", content: "{}" },
        { path: "public/media/a.png", base64: "aGVsbG8=" },
      ],
    });

    expect(readdirSync(join(root, "content/cms")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(join(root, "public/media")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("treats publishing unchanged content as success", async () => {
    const repo = new LocalRepository(root);
    const file = { path: "content/cms/a.json", content: "{}" };
    await repo.commitFiles({ message: "first", files: [file] });
    const head = headSha();

    const again = await repo.commitFiles({ message: "same again", files: [file] });

    expect(again.commitSha).toBe(head);
  });

  it("publishes when someone committed something else while the editor was open", async () => {
    const repo = new LocalRepository(root);
    const opened = headSha();
    writeFileSync(join(root, "README.md"), "an unrelated change\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "unrelated"]);

    await repo.commitFiles({
      message: "mine",
      files: [{ path: "content/cms/home.hero.json", content: '{"heading":"Mine"}\n' }],
      expectedHeadSha: opened,
    });

    expect(readFileSync(join(root, "content/cms/home.hero.json"), "utf8")).toContain("Mine");
  });

  it("refuses when that same content was committed while the editor was open", async () => {
    const repo = new LocalRepository(root);
    const opened = headSha();
    writeFileSync(join(root, "content/cms/home.hero.json"), '{"heading":"Theirs"}\n');
    git(["add", "-A"]);
    git(["commit", "-qm", "theirs"]);

    await expect(
      repo.commitFiles({
        message: "mine",
        files: [{ path: "content/cms/home.hero.json", content: '{"heading":"Mine"}\n' }],
        expectedHeadSha: opened,
      }),
    ).rejects.toThrow(/moved while you were editing/);
    expect(readFileSync(join(root, "content/cms/home.hero.json"), "utf8")).toContain("Theirs");
  });

  it("refuses to publish over an edit someone made by hand and has not committed", async () => {
    const repo = new LocalRepository(root);
    writeFileSync(join(root, "content/cms/home.hero.json"), '{"heading":"Theirs"}\n');
    git(["add", "-A"]);
    git(["commit", "-qm", "theirs"]);
    const opened = headSha();
    writeFileSync(join(root, "content/cms/home.hero.json"), '{"heading":"Hand edit"}\n');

    await expect(
      repo.commitFiles({
        message: "mine",
        files: [{ path: "content/cms/home.hero.json", content: '{"heading":"Mine"}\n' }],
        expectedHeadSha: opened,
      }),
    ).rejects.toThrow(/unsaved changes/);
    expect(readFileSync(join(root, "content/cms/home.hero.json"), "utf8")).toContain("Hand edit");
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

describe("editors", () => {
  const signIn = async (fields: Record<string, string>) => {
    const response = await app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const as = (cookie: string) => ({
    get: (path: string) => app.request(path, { headers: { cookie } }),
    post: (path: string, fields: Record<string, string>) =>
      app.request(path, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      }),
  });
  const addAlice = () =>
    post("/editors", {
      name: "Alice Uwase",
      email: "alice@example.com",
      password: "a long passphrase",
    });

  it("lets the owner add someone who then signs in as themselves", async () => {
    expect((await addAlice()).status).toBe(200);
    const { response, cookie } = await signIn({
      email: "alice@example.com",
      password: "a long passphrase",
    });
    expect(response.status).toBe(303);
    expect(await (await as(cookie).get("/")).text()).toContain("Alice Uwase");

    const wrong = await signIn({ email: "alice@example.com", password: "not her passphrase" });
    expect(wrong.response.status).toBe(401);
  });

  it("commits an editor's publish under their own name", async () => {
    await addAlice();
    const { cookie } = await signIn({ email: "alice@example.com", password: "a long passphrase" });
    await as(cookie).post("/sites/local-1/regions/home.hero", {
      headSha: "",
      "f[heading]": "By Alice",
    });

    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(author.trim()).toBe("Alice Uwase <alice@example.com>");
  });

  it("keeps sites and people the owner's to change", async () => {
    await addAlice();
    const { cookie } = await signIn({ email: "alice@example.com", password: "a long passphrase" });
    const editor = as(cookie);
    expect((await editor.get("/editors")).status).toBe(403);
    expect((await editor.get("/sites/new")).status).toBe(403);
    expect((await editor.post("/sites/local-1/delete", {})).status).toBe(403);
    expect((await editor.get("/sites/setup?path=/tmp")).status).toBe(403);
    expect((await editor.post("/sites/setup", { path: "/tmp", template: "blank" })).status).toBe(
      403,
    );
    expect((await editor.post("/sites/clone", { url: "https://example.com/a.git" })).status).toBe(
      403,
    );
    expect((await editor.post("/sites/clone/dismiss", { folder: "a" })).status).toBe(403);
    expect((await editor.get("/git-access")).status).toBe(403);
    expect(
      (await editor.post("/git-access/token", { host: "github.com", token: "x" })).status,
    ).toBe(403);
    expect((await editor.post("/git-access/github", {})).status).toBe(403);
    expect((await editor.get("/git-access/github/created?code=x&state=y")).status).toBe(403);
    expect((await editor.get("/sites/local-1/regions/home.hero")).status).toBe(200);
  });

  it("signs out someone the owner removed", async () => {
    await addAlice();
    const { cookie } = await signIn({ email: "alice@example.com", password: "a long passphrase" });
    const id = store.findEditor("alice@example.com")!.id;
    await post(`/editors/${id}/delete`, {});

    const after = await as(cookie).get("/");
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toBe("/sign-in");
  });

  it("refuses a weak password and a duplicate email", async () => {
    expect(
      (await post("/editors", { name: "Bob", email: "bob@example.com", password: "short" })).status,
    ).toBe(422);
    await addAlice();
    expect((await addAlice()).status).toBe(422);
  });

  it("tells each person who else has the same content open", async () => {
    await addAlice();
    const { cookie } = await signIn({ email: "alice@example.com", password: "a long passphrase" });
    await as(cookie).get("/sites/local-1/regions/home.hero");

    const owner = await (
      await app.request("/sites/local-1/regions/home.hero", { headers: signedIn })
    ).text();
    expect(owner).toContain("Also open here: Alice Uwase");
  });
});

describe("history", () => {
  it("lists every publish of a region and restores an old one into the editor, unpublished", async () => {
    await post("/sites/local-1/regions/home.hero", { headSha: "", "f[heading]": "First words" });
    await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      "f[heading]": "Second thoughts",
    });

    const page = await (
      await app.request("/sites/local-1/regions/home.hero/history", { headers: signedIn })
    ).text();
    const shas = [...page.matchAll(/history\/([0-9a-f]{40})\/restore/g)].map((match) => match[1]!);
    expect(page).toContain("Published now");
    expect(shas).toHaveLength(1);

    const restore = await post(`/sites/local-1/regions/home.hero/history/${shas[0]}/restore`, {});
    expect(restore.status).toBe(303);

    const published = JSON.parse(readFileSync(join(root, "content/cms/home.hero.json"), "utf8"));
    expect(published.heading).toBe("Second thoughts");
    const editor = await (
      await app.request("/sites/local-1/regions/home.hero", { headers: signedIn })
    ).text();
    expect(editor).toContain('value="First words"');
    expect(editor).toContain("Unsaved edits restored");
  });

  it("refuses a commit name that is not one", async () => {
    expect((await post("/sites/local-1/regions/home.hero/history/HEAD~1/restore", {})).status).toBe(
      404,
    );
  });
});

describe("the live site", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  let www: string;

  beforeEach(() => {
    www = mkdtempSync(join(tmpdir(), "greatcms-www-"));
    mkdirSync(join(www, "releases", A), { recursive: true });
    mkdirSync(join(www, "releases", B), { recursive: true });
    writeFileSync(
      join(www, "status.json"),
      JSON.stringify({
        live: { sha: B, message: "content: update home.hero", at: "2026-10-13T08:00:00Z" },
        failed: {
          sha: "c".repeat(40),
          message: "content: broken",
          at: "2026-10-13T09:00:00Z",
          log: "astro: oops",
        },
        checkedAt: "2026-10-13T09:00:05Z",
      }),
    );
    store.updateSite("local-1", {
      name: "On disk",
      devUrl: "",
      pushAfterPublish: false,
      deployRoot: www,
    });
  });

  afterEach(() => rmSync(www, { recursive: true, force: true }));

  it("shows what is live, what failed, and what a rollback can return to", async () => {
    const page = await (await app.request("/sites/local-1", { headers: signedIn })).text();
    expect(page).toContain("content: update home.hero");
    expect(page).toContain("The last publish did not build");
    expect(page).toContain("astro: oops");
    expect(page).toContain(`name="sha" value="${A}"`);
    expect(page).not.toContain(`name="sha" value="${B}"`);
  });

  it("asks the builder for a rollback with a file, and refuses a release it does not have", async () => {
    expect((await post("/sites/local-1/rollback", { sha: A })).status).toBe(303);
    expect(readFileSync(join(www, "rollback"), "utf8").trim()).toBe(A);
    expect((await post("/sites/local-1/rollback", { sha: "d".repeat(40) })).status).toBe(404);
    expect((await post("/sites/local-1/rollback", { sha: "../../etc" })).status).toBe(404);
  });
});

describe("search", () => {
  it("finds words in published content and drafts, and links to the field", async () => {
    await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      "f[heading]": "Consulting in Kigali",
    });
    await post("/sites/local-1/regions/home.hero/draft", {
      "f[heading]": "Consulting in Kigali",
      "f[subtitle]": "Café talks",
    });

    const page = await (
      await app.request("/sites/local-1/search?q=kigali", { headers: signedIn })
    ).text();
    expect(page).toContain("<mark>Kigali</mark>");
    expect(page).toContain('href="/sites/local-1/regions/home.hero#f-heading"');

    const accents = await (
      await app.request("/sites/local-1/search?q=cafe", { headers: signedIn })
    ).text();
    expect(accents).toContain("<mark>Café</mark>");

    const none = await (
      await app.request("/sites/local-1/search?q=zzzz", { headers: signedIn })
    ).text();
    expect(none).toContain("Nothing on this site says");
  });
});

const pad = (n: number) => String(n).padStart(2, "0");
const inAnHour = () => {
  const at = new Date(Date.now() + 60 * 60_000);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
};

describe("publishing later", () => {
  const app2 = () => app as unknown as { runDueSchedules(now?: number): Promise<void> };

  beforeEach(() => {
    app = createApp({ store, password: PASSWORD, secret: SECRET, timeZone: "UTC" });
  });

  it("keeps the edit until its time, then publishes it as an ordinary commit", async () => {
    const response = await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      action: "schedule",
      publishAt: inAnHour(),
      "f[heading]": "Announced at nine",
    });
    expect(response.status).toBe(303);
    expect(existsSync(join(root, "content/cms/home.hero.json"))).toBe(false);
    expect(await (await app.request("/sites/local-1", { headers: signedIn })).text()).toContain(
      "Waiting",
    );

    await app2().runDueSchedules(Date.now());
    expect(existsSync(join(root, "content/cms/home.hero.json"))).toBe(false);

    await app2().runDueSchedules(Date.now() + 2 * 60 * 60_000);
    const published = JSON.parse(readFileSync(join(root, "content/cms/home.hero.json"), "utf8"));
    expect(published.heading).toBe("Announced at nine");
    expect(store.listScheduled("local-1")[0]?.status).toBe("published");
  });

  it("does not overwrite a change published while it waited", async () => {
    const started = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    await post("/sites/local-1/regions/home.hero", {
      headSha: started,
      action: "schedule",
      publishAt: inAnHour(),
      "f[heading]": "Scheduled words",
    });
    await post("/sites/local-1/regions/home.hero", {
      headSha: started,
      "f[heading]": "Published meanwhile",
    });

    await app2().runDueSchedules(Date.now() + 2 * 60 * 60_000);
    const job = store.listScheduled("local-1")[0]!;
    expect(job.status).toBe("failed");
    expect(job.detail).toContain("changed after it was scheduled");
    expect(JSON.parse(readFileSync(join(root, "content/cms/home.hero.json"), "utf8")).heading).toBe(
      "Published meanwhile",
    );
  });

  it("refuses a time in the past, and can be cancelled", async () => {
    expect(
      (
        await post("/sites/local-1/regions/home.hero", {
          headSha: "",
          action: "schedule",
          publishAt: "2020-01-01T09:00",
          "f[heading]": "x",
        })
      ).status,
    ).toBe(422);
    await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      action: "schedule",
      publishAt: inAnHour(),
      "f[heading]": "x",
    });
    const job = store.listScheduled("local-1")[0]!;
    await post(`/sites/local-1/scheduled/${job.id}/cancel`, {});
    await app2().runDueSchedules(Date.now() + 2 * 60 * 60_000);
    expect(store.getScheduled(job.id)?.status).toBe("cancelled");
    expect(existsSync(join(root, "content/cms/home.hero.json"))).toBe(false);
  });
});

describe("sharing the preview", () => {
  beforeEach(() => {
    app = createApp({
      store,
      password: PASSWORD,
      secret: SECRET,
      publicUrl: "https://studio.example.com",
      cookieDomain: "example.com",
    });
    store.updateSite("local-1", {
      name: "On disk",
      devUrl: "https://preview.example.com",
      pushAfterPublish: false,
    });
  });

  const check = (headers: Record<string, string>) =>
    app.request("/auth/check", {
      headers: {
        "x-forwarded-host": "preview.example.com",
        "x-forwarded-proto": "https",
        ...headers,
      },
    });

  it("gives someone without an account the preview, and only the preview", async () => {
    const page = await (await post("/sites/local-1/share", { path: "/services" })).text();
    const link = /value="(https:\/\/preview\.example\.com\/services\?greatcms-share=[^"]+)"/.exec(
      page,
    )?.[1];
    expect(link).toBeTruthy();
    const url = new URL(link!.replace(/&amp;/g, "&"));

    const first = await check({ "x-forwarded-uri": `${url.pathname}${url.search}` });
    expect(first.status).toBe(302);
    const redeem = new URL(first.headers.get("location")!);
    expect(redeem.origin + redeem.pathname).toBe("https://studio.example.com/share");

    const redeemed = await app.request(`${redeem.pathname}${redeem.search}`);
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get("location")).toBe("https://preview.example.com/services");
    const cookie = redeemed.headers.get("set-cookie")!;
    expect(cookie).toContain("Domain=example.com");

    const shareOnly = cookie.split(";")[0]!;
    expect((await check({ cookie: shareOnly, "x-forwarded-uri": "/" })).status).toBe(204);
    // The studio itself still wants a sign-in.
    expect((await app.request("/", { headers: { cookie: shareOnly } })).status).toBe(303);
    // And the token is no good for another site's preview.
    expect(
      (
        await app.request("/auth/check", {
          headers: { cookie: shareOnly, "x-forwarded-host": "preview.other.com" },
        })
      ).status,
    ).not.toBe(204);
  });

  it("refuses a forged token", async () => {
    const forged = await app.request(
      "/share?token=local-1.99999999999999.forged&next=https%3A%2F%2Fpreview.example.com%2F",
    );
    expect(forged.status).toBe(403);
  });
});

describe("recent changes", () => {
  const page = async (path: string) => (await app.request(path, { headers: signedIn })).text();

  it("lists commits to content from Git, including ones made outside the studio", async () => {
    await post("/sites/local-1/regions/home.hero", {
      headSha: "",
      "f[heading]": "From the studio",
    });
    writeFileSync(join(root, "content/cms/home.hero.json"), '{ "heading": "By hand" }\n');
    git(["commit", "-qam", "Fix the hero by hand", "--author", "Someone Else <else@example.com>"]);

    const html = await page("/sites/local-1");
    expect(html).toContain("Recent changes");
    expect(html).toContain("Fix the hero by hand");
    expect(html).toContain('href="/sites/local-1/regions/home.hero"');
    expect(html).toMatch(/Edited <time[^>]*>[^<]+<\/time> by Someone Else/);
  });

  it("marks content with unsaved edits, and counts and dates collection entries", async () => {
    writeFileSync(
      join(root, ".cms/schema.yaml"),
      `${readFileSync(join(root, ".cms/schema.yaml"), "utf8")}collections:
  posts:
    label: Posts
    entryLabel: post
    path: content/posts
    format: json
    fields:
      title: { type: text, required: true }
`,
    );
    mkdirSync(join(root, "content/posts"), { recursive: true });
    writeFileSync(join(root, "content/posts/hello.json"), '{ "title": "Hello" }\n');
    git(["add", "-A"]);
    git(["commit", "-qm", "First post"]);
    mkdirSync(join(root, ".cms/draft/content/cms"), { recursive: true });
    writeFileSync(join(root, ".cms/draft/content/cms/home.hero.json"), '{ "heading": "Draft" }\n');

    const overview = await page("/sites/local-1");
    expect(overview).toContain("1 post in");
    expect(overview).toContain("Unsaved edits</span>");
    const list = await page("/sites/local-1/collections/posts");
    expect(list).toMatch(/class="entry-meta"[^>]*><time datetime/);
  });
});

/** Copy from Git, the token store and the GitHub App, checked from the outside in. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppOptions } from "../src/app.js";
import {
  Clones,
  cloneFailure,
  cloneUrlProblem,
  isPrivateAddress,
  reachesPrivateNetwork,
  sweepStaleClones,
  writePreviewList,
} from "../src/connect.js";
import { Store } from "../src/db.js";
import { GitAccess } from "../src/git-access.js";
import { GitHub, GitHubError } from "../src/github.js";
import { PASSWORD, SECRET, signedIn } from "./site.js";

let root: string;
let gitCalls: string[][];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-hardening-connect-"));
  gitCalls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function app(extra: Partial<AppOptions> = {}) {
  return createApp({
    store: new Store(":memory:"),
    password: PASSWORD,
    secret: SECRET,
    sitesRoot: root,
    resolveHost: async () => ["93.184.215.14"],
    cloneGit: async (args) => {
      gitCalls.push(args);
      mkdirSync(args.at(-1) as string, { recursive: true });
    },
    ...extra,
  });
}

function post(target: ReturnType<typeof createApp>, path: string, fields: Record<string, string>) {
  return target.request(path, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

const failing = () => Promise.reject(new Error("ENOTFOUND"));
const waiting = () => new Promise<void>(() => {});
const answer = (made: object) =>
  (async () => new Response(JSON.stringify(made), { status: 201 })) as unknown as typeof fetch;
const stateOf = (github: GitHub) =>
  new URL(github.creation("https://studio.example.com").action).searchParams.get("state") as string;

const cloneError = async (response: Response) =>
  new JSDOM(await response.text()).window.document.body.textContent ?? "";

describe("an address with a sign-in in it", () => {
  it.each([
    "https://token:secret@example.com/private.git",
    "https://ghp_abcdefgh12345678@example.com/private.git",
    "ssh://git:secret@example.com/private.git",
  ])("is refused before git sees %s", async (url) => {
    const response = await post(app(), "/sites/clone", { url });
    expect(response.status).toBe(422);
    expect(await cloneError(response)).toContain("save a token for that host on Git access");
    expect(gitCalls).toEqual([]);
  });

  it("still takes an SSH user, which is not a secret", () => {
    expect(cloneUrlProblem("ssh://git@example.com/me/site.git")).toBeNull();
    expect(cloneUrlProblem("git@example.com:me/site.git")).toBeNull();
    expect(cloneUrlProblem("https://example.com/me/site.git")).toBeNull();
  });
});

describe("an address inside this machine or its network", () => {
  it.each([
    "http://127.0.0.1:8787/x.git",
    "http://localhost/x.git",
    "http://[::1]/x.git",
    "http://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/x.git",
    "https://192.168.1.10/x.git",
    "https://172.20.0.2/x.git",
    "http://0.0.0.0/x.git",
    "http://2130706433/x.git",
    "http://[::ffff:127.0.0.1]/x.git",
    "git@10.1.2.3:me/site.git",
    "ssh://git@gitea/me/site.git",
    "http://metadata.google.internal.localhost/x.git",
  ])("is not copied from: %s", async (url) => {
    const response = await post(app(), "/sites/clone", { url });
    expect(response.status).toBe(422);
    expect(await cloneError(response)).toContain("private network");
    expect(gitCalls).toEqual([]);
  });

  it("is refused when a public-looking name resolves there", async () => {
    const target = app({ resolveHost: async () => ["93.184.215.14", "10.0.0.7"] });
    const response = await post(target, "/sites/clone", { url: "https://rebind.example/x.git" });
    expect(response.status).toBe(422);
    expect(gitCalls).toEqual([]);
  });

  it("is allowed once the studio is told its Git server lives there", async () => {
    const target = app({ clonePrivate: true });
    const response = await post(target, "/sites/clone", { url: "https://10.0.0.5/site.git" });
    expect(response.status).toBe(303);
    expect(gitCalls).toHaveLength(1);
  });

  it("knows the ranges", () => {
    for (const address of ["100.64.0.1", "198.18.0.1", "224.0.0.1", "fe80::1", "fd00::1", "::"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.215.14", "8.8.8.8", "2606:4700::1111", "172.32.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("leaves a name that does not resolve for git to report", async () => {
    expect(await reachesPrivateNetwork("https://nowhere.example/x.git", failing)).toBe(false);
  });
});

describe("a clone", () => {
  it("never follows a redirect", async () => {
    await post(app(), "/sites/clone", { url: "https://example.com/site.git" });
    const args = gitCalls[0] as string[];
    expect(args.slice(0, args.indexOf("clone"))).toContain("http.followRedirects=false");
    expect(
      cloneFailure(
        Object.assign(new Error("x"), {
          stderr:
            "fatal: unable to access 'https://example.com/old.git/': The requested URL returned error: 301",
        }),
      ),
    ).toContain("redirects are not followed");
  });

  it("is refused while the same folder, or too many others, are being copied", async () => {
    const target = app({ cloneGit: waiting, cloneLimits: { concurrent: 2 } });
    const start = (name: string) =>
      post(target, "/sites/clone", { url: `https://example.com/${name}.git` });
    expect((await start("one")).status).toBe(303);
    const again = await start("one");
    expect(again.status).toBe(422);
    expect(await cloneError(again)).toContain("already being copied");
    expect((await start("two")).status).toBe(303);
    const third = await start("three");
    expect(third.status).toBe(422);
    expect(await cloneError(third)).toContain("Other copies are still running");
  });

  it("is stopped once it outgrows the limit, leaving nothing behind", async () => {
    const clones = new Clones(
      root,
      (args, _config, signal) =>
        new Promise((_, reject) => {
          const target = args.at(-1) as string;
          mkdirSync(join(target, "objects"), { recursive: true });
          writeFileSync(join(target, "objects", "pack"), Buffer.alloc(64 * 1024));
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { maxBytes: 1024, measureEveryMs: 10 },
    );
    await clones.start("https://example.com/huge.git", "huge", "");
    const [job] = clones.list();
    expect(job).toMatchObject({ state: "failed" });
    expect(job?.state === "failed" && job.reason).toContain("larger than");
    expect(readdirSync(root)).toEqual([]);
  });

  it("is stopped with the studio, and leaves no folder behind", async () => {
    const target = app({
      cloneGit: (args, _config, signal) =>
        new Promise((_, reject) => {
          mkdirSync(args.at(-1) as string, { recursive: true });
          signal?.addEventListener("abort", () => reject(new Error("stopped")));
        }),
    });
    await post(target, "/sites/clone", { url: "https://example.com/slow.git" });
    expect(readdirSync(root)).toEqual([".slow.cloning"]);
    target.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readdirSync(root)).toEqual([]);
  });

  it("forgets the oldest finished copies rather than keeping every one", async () => {
    const clones = new Clones(root, () => Promise.reject(new Error("nope")));
    for (let index = 0; index < 30; index++) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as a person would
      await clones.start(`https://example.com/r${index}.git`, `r${index}`, "");
    }
    expect(clones.list()).toHaveLength(20);
    expect(clones.list().at(-1)?.folder).toBe("r29");
  });

  it("left half-made by a studio that stopped is cleared at the next start", () => {
    mkdirSync(join(root, ".shop.cloning", "objects"), { recursive: true });
    mkdirSync(join(root, "shop-live"));
    mkdirSync(join(root, ".git"));
    expect(sweepStaleClones(root)).toEqual([".shop.cloning"]);
    expect(readdirSync(root).toSorted()).toEqual([".git", "shop-live"]);
  });
});

describe("setting a folder up", () => {
  it("is the owner's alone, by every spelling of the address", async () => {
    const store = new Store(":memory:");
    const target = createApp({ store, password: PASSWORD, secret: SECRET, sitesRoot: root });
    await post(target, "/editors", {
      name: "Ed",
      email: "ed@example.com",
      password: "a long enough password",
    });
    const signIn = await target.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ed@example.com", password: "a long enough password" }),
    });
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] as string;
    mkdirSync(join(root, "bare"));
    const body = new URLSearchParams({ path: join(root, "bare"), name: "Bare", template: "blank" });
    for (const path of [
      "/sites/setup",
      "/sites/setup/",
      "/sites//setup",
      "/sites/%73etup",
      "/SITES/setup",
      "/sites/setup?x=1",
      "/sites/./setup",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each spelling is its own request
      const response = await target.request(path, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect([403, 404], path).toContain(response.status);
    }
    expect(existsSync(join(root, "bare", ".cms"))).toBe(false);
    expect(store.listSites()).toEqual([]);
  });

  it("connects the folder under one spelling of its path", async () => {
    mkdirSync(join(root, "bare"));
    const store = new Store(":memory:");
    const target = createApp({ store, password: PASSWORD, secret: SECRET, sitesRoot: root });
    const response = await post(target, "/sites/setup", {
      path: `${root}/other/../bare/`,
      name: "Bare",
      template: "blank",
    });
    expect(response.status).toBe(303);
    expect(store.listSites().map((site) => site.path)).toEqual([join(root, "bare")]);
  });
});

describe("what is kept on disk", () => {
  it("keeps tokens in a folder and file only the studio's user can read", () => {
    const dir = join(root, "git");
    const access = new GitAccess(dir, {});
    expect(access.saveToken("gitlab.com", "", "glpat-abcdefgh12345678")).toBeNull();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "git-credentials")).mode & 0o777).toBe(0o600);
    access.saveToken("codeberg.org", "me", "another-token-123456");
    expect(readdirSync(dir)).toEqual(["git-credentials"]);
    expect(
      readFileSync(join(dir, "git-credentials"), "utf8").split("\n").filter(Boolean),
    ).toHaveLength(2);
  });

  it("writes the preview list through no link planted beside it", () => {
    const file = join(root, "previews.json");
    const elsewhere = join(root, "elsewhere");
    writeFileSync(elsewhere, "untouched");
    symlinkSync(elsewhere, join(root, `.previews.json.${process.pid}.tmp`));
    writePreviewList(file, []);
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, sites: [] });
  });
});

describe("the GitHub App's creation", () => {
  const good = {
    id: 5,
    slug: "greatcms-studio",
    client_id: "Iv1.abc",
    pem: "-----BEGIN RSA PRIVATE KEY-----\n",
    html_url: "https://github.com/apps/greatcms-studio",
    owner: { login: "acme", type: "User" },
  };

  it("keeps only so many unanswered attempts, and each answers once", async () => {
    const github = new GitHub(join(root, "git", "app.json"), undefined, answer(good));
    const first = stateOf(github);
    for (let index = 0; index < 40; index++) stateOf(github);
    const last = stateOf(github);
    await expect(github.finishCreation("code", first)).rejects.toThrow(GitHubError);
    await expect(github.finishCreation("code", last)).resolves.toMatchObject({ id: 5 });
    await expect(github.finishCreation("code", last)).rejects.toThrow(/expired|not started/);
  });

  it("refuses an answer that would later send the browser to another site", async () => {
    const github = new GitHub(
      join(root, "git", "app.json"),
      undefined,
      answer({ ...good, html_url: "https://github.com.evil.example/apps/x" }),
    );
    await expect(github.finishCreation("code", stateOf(github))).rejects.toThrow(GitHubError);
    expect(github.config()).toBeNull();
  });

  it("stores the key for the studio's user only, and never sends anyone off this GitHub", async () => {
    const file = join(root, "git", "app.json");
    const github = new GitHub(file, undefined, answer(good));
    await github.finishCreation("code", stateOf(github));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "git")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(root, "git"))).toEqual(["app.json"]);
    writeFileSync(
      file,
      JSON.stringify({ ...github.config(), htmlUrl: "https://evil.example/app" }),
    );
    expect(github.installUrl()).toBeNull();
  });

  it("only signs in addresses on its own host and scheme", () => {
    const github = new GitHub(join(root, "git", "app.json"));
    expect(github.ownerOf("https://github.com/acme/site.git")).toBe("acme");
    for (const url of [
      "http://github.com/acme/site.git",
      "https://github.com.evil.example/acme/site.git",
      "https://evil.example/github.com/acme/site.git",
      "https://github.com@evil.example/acme/site.git",
      "https://githubXcom/acme/site.git",
      "https://github.com:8443/acme/site.git",
    ]) {
      expect(github.ownerOf(url), url).toBeNull();
    }
  });
});

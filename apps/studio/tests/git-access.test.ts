/** The studio's own way into private repositories: a key it makes and tokens per host. */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axe from "axe-core";
import { HtmlValidate } from "html-validate";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Store } from "../src/db.js";
import { GitAccess, tokenUser } from "../src/git-access.js";
import { PASSWORD, SECRET, signedIn } from "./site.js";

const TOKEN = "github_pat_11ABCDEFG0123456789_secretpart";
const hasKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "greatcms-git-"));
  env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What git would send for a host, asked the way a clone asks. */
function credentialFor(host: string): string {
  return execFileSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${host}\n\n`,
    env: { PATH: process.env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: "0", ...env },
    encoding: "utf8",
  });
}

describe("tokens", () => {
  it("hands a saved token to git for its host, and only there", () => {
    const access = new GitAccess(dir, env);
    expect(access.saveToken("https://github.com/someone/site", "", TOKEN)).toBeNull();

    expect(credentialFor("github.com")).toContain(`password=${TOKEN}`);
    expect(credentialFor("github.com")).toContain("username=x-access-token");
    expect(() => credentialFor("gitlab.com")).toThrow();
    // The image's own config stays in place beside ours.
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(["safe.directory", "*"]);
  });

  it("keeps one token per host, readable by nobody else, and forgets it when removed", () => {
    const access = new GitAccess(dir, env);
    access.saveToken("github.com", "", "first-token-value");
    access.saveToken("github.com", "", TOKEN);
    access.saveToken("git.example.com", "deploy", "another-token-value");

    expect(access.tokens()).toEqual([
      { host: "github.com", username: "x-access-token" },
      { host: "git.example.com", username: "deploy" },
    ]);
    expect(statSync(join(dir, "git-credentials")).mode & 0o777).toBe(0o600);

    access.removeToken("github.com");
    access.removeToken("git.example.com");
    expect(access.tokens()).toEqual([]);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
  });

  it("refuses what git could not use", () => {
    const access = new GitAccess(dir, env);
    expect(access.saveToken("not a host", "", TOKEN)).toContain("host name");
    expect(access.saveToken("git.example.com", "", TOKEN)).toContain("user name");
    expect(access.saveToken("github.com", "", "short")).toContain("token");
    expect(access.saveToken("github.com", "", "has a\nnewline")).toContain("token");
    expect(access.tokens()).toEqual([]);
  });

  it("knows the user name the big hosts expect", () => {
    expect(tokenUser("github.com")).toBe("x-access-token");
    expect(tokenUser("gitlab.com")).toBe("oauth2");
    expect(tokenUser("bitbucket.org")).toBe("x-token-auth");
    expect(tokenUser("git.example.com")).toBeNull();
  });
});

describe.skipIf(!hasKeygen)("an SSH key", () => {
  it("is made once, used by every git, and removed cleanly", async () => {
    const access = new GitAccess(dir, env);
    await access.createKey("greatcms-studio@test");
    const key = access.publicKey();

    expect(key).toMatch(/^ssh-ed25519 \S+ greatcms-studio@test$/);
    expect(env.GIT_CONFIG_KEY_1).toBe("core.sshCommand");
    expect(env.GIT_CONFIG_VALUE_1).toContain(join(dir, "ssh", "id_ed25519"));
    expect(env.GIT_CONFIG_VALUE_1).toContain("StrictHostKeyChecking=accept-new");

    await access.createKey("again");
    expect(access.publicKey()).toBe(key);

    access.removeKey();
    expect(access.publicKey()).toBeNull();
    expect(env.GIT_CONFIG_COUNT).toBe("1");
  });
});

function post(target: ReturnType<typeof createApp>, path: string, fields: Record<string, string>) {
  return target.request(path, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("the Git access page", () => {
  function app() {
    return createApp({
      store: new Store(":memory:"),
      password: PASSWORD,
      secret: SECRET,
      gitAccess: new GitAccess(dir, env),
    });
  }
  it("saves a token and lists its host, never the token itself", async () => {
    const target = app();
    expect(
      (await post(target, "/git-access/token", { host: "github.com", token: TOKEN })).status,
    ).toBe(303);
    const body = await (await target.request("/git-access", { headers: signedIn })).text();
    const { document } = new JSDOM(body).window;

    expect(document.querySelector(".folders")?.textContent).toContain("github.com");
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("secretpart");
  });

  it("says what is wrong with a token on the field", async () => {
    const response = await post(app(), "/git-access/token", { host: "github.com", token: "x" });
    const { document } = new JSDOM(await response.text()).window;
    expect(response.status).toBe(422);
    expect(document.querySelector("#token-value")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("#token-error")?.textContent).toContain("token");
  });

  it.skipIf(!hasKeygen)("makes a key and shows its public half", async () => {
    const target = app();
    expect((await post(target, "/git-access/key", {})).status).toBe(303);
    const { document } = new JSDOM(
      await (await target.request("/git-access", { headers: signedIn })).text(),
    ).window;
    expect(document.querySelector(".public-key")?.textContent).toMatch(/^ssh-ed25519 /);
  });

  it("is valid, accessible HTML with a key and a token on it", async () => {
    const target = app();
    if (hasKeygen) await post(target, "/git-access/key", {});
    await post(target, "/git-access/token", { host: "github.com", token: TOKEN });
    const body = await (await target.request("/git-access", { headers: signedIn })).text();

    const report = await new HtmlValidate({
      extends: ["html-validate:standard"],
      rules: {
        "void-style": "off",
        "doctype-style": "off",
        "attribute-boolean-style": "off",
        "attribute-empty-style": "off",
        "no-trailing-whitespace": "off",
        "no-inline-style": "off",
        "no-redundant-role": "off",
      },
    }).validateString(body);
    expect(
      report.results.flatMap((r) => r.messages.map((m) => `${m.ruleId}: ${m.message}`)),
    ).toEqual([]);

    const { window } = new JSDOM(body, { url: "https://studio.test/" });
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });
    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("is not there without a place to keep them", async () => {
    const plain = createApp({ store: new Store(":memory:"), password: PASSWORD, secret: SECRET });
    expect((await plain.request("/git-access", { headers: signedIn })).status).toBe(404);
  });
});

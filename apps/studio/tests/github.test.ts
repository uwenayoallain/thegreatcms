/** Connecting GitHub through the studio's own GitHub App, against a stand-in for GitHub's API. */

import { execFileSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HtmlValidate } from "html-validate";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Store } from "../src/db.js";
import { appName, GitHub, PERMISSIONS } from "../src/github.js";
import { withGitConfig } from "../src/repo.js";
import { PASSWORD, SECRET, signedIn } from "./site.js";

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let dir: string;
let file: string;
let calls: Array<{ method: string; path: string; auth: string }>;
let repositoryCount: number;
let tokenNumber: number;
/** The repositories whose `.cms` folder holds a schema. */
let schemaIn: Set<string>;

function json(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

/** GitHub's API, as much of it as the studio uses. */
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
  calls.push({ method, path: url.pathname + url.search, auth });
  if (url.pathname === "/app-manifests/good-code/conversions") {
    return json({
      id: 7,
      slug: "greatcms-studio-ab12",
      client_id: "Iv1.abc",
      pem: keys.privateKey,
      html_url: "https://github.com/apps/greatcms-studio-ab12",
      owner: { login: "acme", type: "Organization" },
    });
  }
  if (url.pathname === "/app/installations" && method === "GET") {
    return json([{ id: 11, account: { login: "Acme" } }]);
  }
  if (url.pathname === "/app/installations/11/access_tokens") {
    tokenNumber++;
    return json({
      token: `ghs_token${tokenNumber}`,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
  }
  if (url.pathname === "/app/installations/11" && method === "DELETE") return json(null, 204);
  if (url.pathname === "/installation/repositories") {
    const page = Number(url.searchParams.get("page"));
    const start = (page - 1) * 100;
    const count = Math.max(0, Math.min(100, repositoryCount - start));
    return json({
      repositories: Array.from({ length: count }, (_, index) => ({
        full_name: `acme/site-${start + index}`,
        name: `site-${start + index}`,
        owner: { login: "acme" },
        clone_url: `https://github.com/acme/site-${start + index}.git`,
        private: true,
        default_branch: "main",
      })),
    });
  }
  const contents = /^\/repos\/(acme\/site-\d+)\/contents\/\.cms$/.exec(url.pathname);
  if (contents && schemaIn.has(contents[1] as string)) {
    return json([{ type: "file", name: "schema.yaml" }]);
  }
  return json({ message: "Not Found" }, 404);
};

/** A GitHub that has made its app, as after the owner came back from GitHub. */
async function connected() {
  const github = new GitHub(file, undefined, fakeGitHub);
  const { action } = github.creation("https://studio.example.com");
  const state = new URL(action).searchParams.get("state") as string;
  await github.finishCreation("good-code", state);
  return github;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "greatcms-github-"));
  file = join(dir, "git", "github-app.json");
  calls = [];
  repositoryCount = 2;
  tokenNumber = 0;
  schemaIn = new Set();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("making the app", () => {
  it("asks GitHub for an app that can touch file contents and nothing else", () => {
    const github = new GitHub(file, undefined, fakeGitHub);
    const { action, manifest } = github.creation("https://studio.example.com");
    const parsed = JSON.parse(manifest);

    expect(action).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=[\w-]{20,}$/);
    expect(parsed.default_permissions).toEqual(PERMISSIONS);
    expect(parsed.default_events).toEqual([]);
    expect(parsed.public).toBe(false);
    expect(parsed.hook_attributes.active).toBe(false);
    expect(parsed.redirect_url).toBe("https://studio.example.com/git-access/github/created");
    expect(parsed.setup_url).toBe("https://studio.example.com/git-access/github/installed");
    expect(parsed.name).toBe("GreatCMS studio.example.com");
    expect(parsed.description).toContain("studio.example.com");
    expect(parsed.description).toContain("Signs you in with your GitHub account");
    expect(parsed.description).toContain("never runs their code");
    expect(parsed.url).toBe("https://studio.example.com");
    expect(parsed.description.length).toBeLessThanOrEqual(400);
  });

  it("names a studio with no public name so two on localhost do not collide", () => {
    expect(appName("http://localhost:8787")).toMatch(/^GreatCMS Studio [0-9a-f]{4}$/);
    expect(appName("https://a-very-long-studio-host-name.example.com")).toMatch(
      /^GreatCMS Studio [0-9a-f]{4}$/,
    );
  });

  it("serves the logo GitHub asks to have uploaded, without a sign-in", async () => {
    const target = createApp({ store: new Store(":memory:"), password: PASSWORD, secret: SECRET });
    const logo = await target.request("/greatcms-logo.png");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
  });

  it("makes it for an organization, or on GitHub Enterprise Server, when asked", () => {
    expect(new GitHub(file).creation("https://s.example.com", "acme").action).toMatch(
      /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/,
    );
    const server = new GitHub(file, "https://git.example.com/");
    expect(server.api).toBe("https://git.example.com/api/v3");
    expect(server.creation("https://s.example.com").action).toMatch(
      /^https:\/\/git\.example\.com\/settings\/apps\/new/,
    );
  });

  it("keeps the app's key readable by the studio alone", async () => {
    const github = await connected();
    expect(github.config()?.slug).toBe("greatcms-studio-ab12");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(github.installUrl()).toBe(
      "https://github.com/apps/greatcms-studio-ab12/installations/new",
    );
    expect(github.settingsUrl()).toBe(
      "https://github.com/organizations/acme/settings/apps/greatcms-studio-ab12",
    );
  });

  it("refuses a return from GitHub it did not send there, and a state used twice", async () => {
    const github = new GitHub(file, undefined, fakeGitHub);
    await expect(github.finishCreation("good-code", "made-up")).rejects.toThrow("expired");
    const state = new URL(github.creation("https://s.example.com").action).searchParams.get(
      "state",
    ) as string;
    await github.finishCreation("good-code", state);
    await expect(github.finishCreation("good-code", state)).rejects.toThrow("expired");
  });

  it("signs as the app with a short-lived token GitHub can check", async () => {
    const github = await connected();
    const now = 1_800_000_000;
    const [header, body, signature] = github.appJwt(now).split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());

    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(claims).toEqual({ iat: now - 60, exp: now + 540, iss: "Iv1.abc" });
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${body}`)
        .verify(keys.publicKey, signature, "base64url"),
    ).toBe(true);
  });
});

describe("signing git in", () => {
  it("gives a repository the app reaches an hour's token, over https even for an SSH address", async () => {
    const github = await connected();
    const configs = await Promise.all(
      [
        "https://github.com/acme/site.git",
        "git@github.com:ACME/site.git",
        "ssh://git@github.com/acme/site",
      ].map((url) => github.gitConfigFor(url)),
    );
    for (const config of configs) {
      expect(config).toEqual([
        [
          "http.https://github.com/.extraheader",
          `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_token1").toString("base64")}`,
        ],
        ["http.https://github.com/.followRedirects", "false"],
        ["url.https://github.com/.insteadOf", "git@github.com:"],
        ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
      ]);
    }
    // One token, reused until shortly before it expires.
    expect(calls.filter((call) => call.path.endsWith("/access_tokens"))).toHaveLength(1);
  });

  it("gives nothing for an account the app is not installed on, or another host", async () => {
    const github = await connected();
    expect(await github.gitConfigFor("https://github.com/someone-else/site.git")).toEqual([]);
    expect(await github.gitConfigFor("https://gitlab.com/acme/site.git")).toEqual([]);
    expect(await new GitHub(join(dir, "none.json")).gitConfigFor("https://github.com/a/b")).toEqual(
      [],
    );
  });

  it("is read by git as config, from the environment rather than the command line", async () => {
    const github = await connected();
    const env = withGitConfig(
      {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "a.b",
        GIT_CONFIG_VALUE_0: "c",
      },
      await github.gitConfigFor("https://github.com/acme/site.git"),
    );
    const read = (args: string[]) =>
      execFileSync("git", ["config", ...args], { env, encoding: "utf8", cwd: dir }).trim();

    expect(
      read(["--get-urlmatch", "http.extraheader", "https://github.com/acme/site.git"]),
    ).toMatch(/^AUTHORIZATION: basic /);
    expect(read(["--get", "a.b"])).toBe("c");
  });

  it("lists every repository it was given, page by page", async () => {
    repositoryCount = 230;
    const github = await connected();
    const repositories = await github.repositories();
    expect(repositories).toHaveLength(230);
    expect(repositories[0]).toMatchObject({ fullName: "acme/site-0", private: true });
    await github.repositories();
    expect(calls.filter((call) => call.path.startsWith("/installation/repositories"))).toHaveLength(
      3,
    );
  });

  it("says plainly when GitHub no longer knows the app", async () => {
    const github = await connected();
    const gone = new GitHub(file, undefined, async () => new Response("{}", { status: 401 }));
    expect(github.config()).not.toBeNull();
    await expect(gone.installations()).rejects.toThrow("may have been deleted");
  });

  it("uninstalls everywhere and forgets the key when disconnected", async () => {
    const github = await connected();
    await github.disconnect();
    expect(calls).toContainEqual(
      expect.objectContaining({ method: "DELETE", path: "/app/installations/11" }),
    );
    expect(existsSync(file)).toBe(false);
    expect(github.config()).toBeNull();
  });
});

function post(target: ReturnType<typeof createApp>, path: string, fields: Record<string, string>) {
  return target.request(path, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

function signIn(target: ReturnType<typeof createApp>) {
  return target.request("/sign-in", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
    body: new URLSearchParams({ password: PASSWORD }),
  });
}

function names(document: Document) {
  return [...document.querySelectorAll("form[action='/sites/github'] .folders strong")].map(
    (name) => name.textContent,
  );
}

describe("the pages", () => {
  let root: string;
  let cloned: Array<{ args: string[]; config: Array<[string, string]> }>;
  /** What a copy brings with it, by repository name; a name not here copies nothing. */
  let copies: Record<string, Record<string, string>>;

  beforeEach(() => {
    root = join(dir, "sites");
    mkdirSync(root);
    cloned = [];
    copies = {};
  });

  function app(github: GitHub) {
    return createApp({
      store: new Store(":memory:"),
      password: PASSWORD,
      secret: SECRET,
      sitesRoot: root,
      github,
      resolveHost: async () => ["140.82.112.3"],
      cloneGit: async (args, config) => {
        cloned.push({ args, config });
        const target = args.at(-1) as string;
        const files = copies[target.split("/").at(-1) as string];
        if (!files) return;
        execFileSync("git", ["init", "-q", target]);
        execFileSync("git", ["-C", target, "remote", "add", "origin", args.at(-2) as string]);
        for (const [name, content] of Object.entries(files)) {
          mkdirSync(join(target, name, ".."), { recursive: true });
          writeFileSync(join(target, name), content);
        }
      },
    });
  }
  it("sends the owner to GitHub with the manifest, allowing that one form to leave the studio", async () => {
    const target = app(new GitHub(file, undefined, fakeGitHub));
    const response = await post(target, "/git-access/github", {});
    const { document } = new JSDOM(await response.text()).window;
    const form = document.querySelector<HTMLFormElement>("form[action^='https://github.com']");

    expect(form?.method).toBe("post");
    expect(
      JSON.parse(form?.querySelector<HTMLInputElement>("[name=manifest]")?.value ?? ""),
    ).toHaveProperty("default_permissions");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://github.com",
    );
    const elsewhere = await target.request("/git-access", { headers: signedIn });
    expect(elsewhere.headers.get("content-security-policy")).not.toContain("github.com");
  });

  it("refuses an organization name GitHub would not have", async () => {
    const response = await post(
      app(new GitHub(file, undefined, fakeGitHub)),
      "/git-access/github",
      {
        organization: "../evil",
      },
    );
    expect(response.status).toBe(422);
  });

  it("goes on to choosing repositories after GitHub makes the app", async () => {
    const github = new GitHub(file, undefined, fakeGitHub);
    const target = app(github);
    const { action } = github.creation("http://localhost");
    const state = new URL(action).searchParams.get("state") as string;

    const bad = await target.request("/git-access/github/created?code=good-code&state=nope", {
      headers: signedIn,
    });
    expect(bad.status).toBe(400);
    const good = await target.request(`/git-access/github/created?code=good-code&state=${state}`, {
      headers: signedIn,
    });
    expect(good.status).toBe(303);
    expect(good.headers.get("location")).toBe(
      "https://github.com/apps/greatcms-studio-ab12/installations/new",
    );
  });

  it("says when an organization's owners still have to approve", async () => {
    const target = app(await connected());
    const response = await target.request(
      "/git-access/github/installed?installation_id=11&setup_action=request",
      { headers: signedIn },
    );
    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelector(".flash")?.textContent).toContain(
      "organization's owners to approve",
    );
  });

  it("lists the app's repositories to tick and add, signed in for that copy alone", async () => {
    const target = app(await connected());
    const { document } = new JSDOM(
      await (await target.request("/sites/new", { headers: signedIn })).text(),
    ).window;
    const rows = [...document.querySelectorAll("form[action='/sites/github'] .folders li")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
      "acme/site-0",
      "acme/site-1",
    ]);
    // Each name is the label of its own tick box, so a click on the name ticks it.
    const box = rows[0]?.querySelector<HTMLInputElement>("input[type=checkbox][name=repo]");
    expect(box?.value).toBe("acme/site-0");
    expect(rows[0]?.querySelector("label")?.getAttribute("for")).toBe(box?.id);
    expect(document.querySelectorAll("script")).toHaveLength(0);

    expect((await post(target, "/sites/github", { repo: "acme/site-0" })).status).toBe(303);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cloned[0]?.args).toContain("https://github.com/acme/site-0.git");
    expect(cloned[0]?.config[0]?.[0]).toBe("http.https://github.com/.extraheader");
  });

  it("copies nothing the app was not given, and says so when nothing is ticked", async () => {
    const target = app(await connected());
    const answers = await Promise.all(
      ["someone/else", "", "acme/site-0/../../x"].map((repo) =>
        post(target, "/sites/github", { repo }),
      ),
    );
    expect(answers.map((answer) => answer.status)).toEqual([422, 422, 422]);
    expect(await answers[0]!.text()).toContain("tick at least one repository");
    expect(cloned).toEqual([]);
  });

  it("puts the repositories that already use GreatCMS first, and says which they are", async () => {
    schemaIn.add("acme/site-1");
    const target = app(await connected());
    const { document } = new JSDOM(
      await (await target.request("/sites/new", { headers: signedIn })).text(),
    ).window;
    const rows = [...document.querySelectorAll("form[action='/sites/github'] .folders li")];
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "acme/site-1 Private · Uses GreatCMS",
      "acme/site-0 Private · Not set up yet",
    ]);
  });

  it("adds every ticked repository: one with a schema opens as a site, one without waits for a starter", async () => {
    copies = {
      "site-0": { "README.md": "plain\n" },
      "site-1": {
        ".cms/schema.yaml":
          "version: 1\nsite:\n  name: One\nregions:\n  home.hero:\n    label: Hero\n    fields:\n      heading: { type: text }\n",
      },
    };
    const target = app(await connected());
    const response = await target.request("/sites/github", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: "repo=acme%2Fsite-0&repo=acme%2Fsite-1",
    });
    expect(response.status).toBe(303);
    // Both are shown as being copied from the first moment, though they are copied in turn.
    const during = await (await target.request("/sites/new", { headers: signedIn })).text();
    expect(during).toContain('http-equiv="refresh"');
    await expect
      .poll(
        async () =>
          (await (await target.request("/", { headers: signedIn })).text()).includes("Site 1"),
        {
          timeout: 10_000,
        },
      )
      .toBe(true);
    expect(cloned.map((copy) => copy.args.at(-2))).toEqual([
      "https://github.com/acme/site-0.git",
      "https://github.com/acme/site-1.git",
    ]);
    const { document } = new JSDOM(
      await (await target.request("/sites/new", { headers: signedIn })).text(),
    ).window;
    const rows = [...document.querySelectorAll("form[action='/sites/github'] .folders li")].map(
      (row) => row.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows).toContain("acme/site-1 Private · Added Open acme/site-1");
    expect(rows).toContain("acme/site-0 Private · In the sites folder");
    expect(document.querySelector("a[href^='/sites/setup?path=']")?.textContent).toContain(
      "site-0",
    );
    expect(document.querySelector("meta[http-equiv=refresh]")).toBeNull();
  });

  it("shows many repositories a page at a time, the GreatCMS ones first, and finds one by name", async () => {
    repositoryCount = 37;
    schemaIn.add("acme/site-30");
    const target = app(await connected());
    const read = async (path: string) =>
      new JSDOM(await (await target.request(path, { headers: signedIn })).text()).window.document;
    const first = await read("/sites/new");
    expect(names(first)).toHaveLength(10);
    expect(names(first)[0]).toBe("acme/site-30");
    expect(first.querySelector(".pager")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Page 1 of 4 · 37 found Next",
    );
    const next = first.querySelector(".pager a[rel=next]")?.getAttribute("href") as string;
    expect(next).toBe("/sites/new?page=2#github");
    expect(names(await read(next.replace("#github", "")))).not.toContain("acme/site-30");
    // A page past the end is the last one, not an empty screen.
    expect(names(await read("/sites/new?page=99"))).toHaveLength(7);

    const search = first.querySelector<HTMLFormElement>("form.repo-search");
    expect(search?.method).toBe("get");
    expect(search?.querySelector("input[name=q]")?.getAttribute("placeholder")).toBe(
      "Search 37 repositories",
    );
    const found = await read("/sites/new?q=SITE-3");
    expect(names(found)).toEqual([
      "acme/site-30",
      "acme/site-3",
      "acme/site-31",
      "acme/site-32",
      "acme/site-33",
      "acme/site-34",
      "acme/site-35",
      "acme/site-36",
    ]);
    expect(found.querySelector<HTMLInputElement>("input[name=q]")?.value).toBe("SITE-3");
    const none = await read("/sites/new?q=%3Cscript%3E");
    expect(none.body.textContent).toContain("No repository's name contains “<script>”.");
    expect(none.querySelectorAll("script")).toHaveLength(0);
  });

  it("opens the same page with or without a trailing slash, and follows none off this host", async () => {
    const target = app(await connected());
    const slashed = await target.request("/sign-in/?with=password");
    expect(slashed.status).toBe(308);
    expect(slashed.headers.get("location")).toBe("/sign-in?with=password");
    const inside = await target.request("/sites/new/", { headers: signedIn });
    expect(inside.headers.get("location")).toBe("/sites/new");
    for (const path of ["//evil.example/", "/\\evil.example/"]) {
      // oxlint-disable-next-line no-await-in-loop -- two addresses, one after the other
      const answer = await target.request(path, { headers: signedIn });
      expect(answer.headers.get("location") ?? "", path).not.toContain("evil.example");
    }
    // A form is never replayed somewhere else.
    expect((await post(target, "/sites/github/", { repo: "acme/site-0" })).status).not.toBe(308);
  });

  it("keeps the other ways to add a site behind one closed section once GitHub is connected", async () => {
    mkdirSync(join(root, "unrelated"));
    const target = app(await connected());
    const read = async (path: string, init: RequestInit = { headers: signedIn }) =>
      new JSDOM(await (await target.request(path, init)).text()).window.document;
    const page = await read("/sites/new");
    const more = page.querySelector("details.more-ways") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.querySelector("summary")?.textContent).toBe("Other ways to add a site");
    // A folder that did not come from GitHub, copying by address, and connecting by path wait inside.
    expect(more.querySelector("#found-all ~ .folders")?.textContent).toContain("unrelated");
    expect(more.querySelector("form[action='/sites/clone']")).toBeTruthy();
    expect(more.querySelector("form[action='/sites'] input[name=path]")).toBeTruthy();
    expect(more.querySelector("a[href='/git-access']")).toBeTruthy();
    expect(page.querySelector("#found")).toBeNull();
    expect(page.querySelector("form[action='/sites/github']")?.closest("details")).toBeNull();

    // Something tried in there and refused opens it, so the reason is in view.
    const refused = new JSDOM(
      await (await post(target, "/sites/clone", { url: "not an address" })).text(),
    ).window.document;
    expect(refused.querySelector<HTMLDetailsElement>("details.more-ways")?.open).toBe(true);

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
    }).validateString(await (await target.request("/sites/new", { headers: signedIn })).text());
    expect(
      report.results.flatMap((r) => r.messages.map((m) => `${m.ruleId}: ${m.message}`)),
    ).toEqual([]);
  });

  it("leaves two repositories unsearched and unpaged", async () => {
    const target = app(await connected());
    const body = await (await target.request("/sites/new", { headers: signedIn })).text();
    expect(body).not.toContain("repo-search");
    expect(body).not.toContain('class="pager"');
  });

  it("marks a repository already copied here by its origin, whatever the folder is called", async () => {
    const copy = join(root, "renamed");
    mkdirSync(copy);
    execFileSync("git", ["init", "-q", copy]);
    execFileSync("git", ["-C", copy, "remote", "add", "origin", "git@github.com:acme/site-1.git"]);
    const target = app(await connected());
    const { document } = new JSDOM(
      await (await target.request("/sites/new", { headers: signedIn })).text(),
    ).window;
    const row = [...document.querySelectorAll("form[action='/sites/github'] .folders li")].find(
      (li) => li.textContent?.includes("acme/site-1"),
    );
    expect(row?.textContent).toContain("In the sites folder");
    expect(row?.querySelector("input")).toBeNull();
  });

  it("shows what the connected app reaches, and how to give it the GreatCMS logo", async () => {
    const target = app(await connected());
    const body = await (await target.request("/git-access", { headers: signedIn })).text();
    const { document } = new JSDOM(body).window;
    const section = document.querySelector("#github")?.parentElement;

    expect(section?.textContent?.replace(/\s+/g, " ")).toContain(
      "It reaches 2 repositories in Acme",
    );
    expect(section?.querySelector(".app-logo img")?.getAttribute("src")).toBe("/greatcms-logo.png");
    expect(section?.querySelector(".app-logo a:last-child")?.getAttribute("href")).toBe(
      "https://github.com/organizations/acme/settings/apps/greatcms-studio-ab12",
    );
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
  });

  it("sends an owner signing in with the password to make the app, until there is one", async () => {
    const fresh = await signIn(app(new GitHub(file, undefined, fakeGitHub)));
    expect(fresh.headers.get("location")).toBe("/git-access");
    const made = await signIn(app(await connected()));
    expect(made.headers.get("location")).toBe("/");
  });

  it("offers to connect GitHub where it is not connected yet", async () => {
    const target = app(new GitHub(file, undefined, fakeGitHub));
    const body = await (await target.request("/sites/new", { headers: signedIn })).text();
    expect(
      new JSDOM(body).window.document.querySelector("#github ~ p a.button")?.getAttribute("href"),
    ).toBe("/git-access");
  });
});

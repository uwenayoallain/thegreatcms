/** Signing in with GitHub, and what each person can then see, against a stand-in for GitHub. */

import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HtmlValidate } from "html-validate";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppOptions, createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { GitHub } from "../src/github.js";
import { RateLimiter } from "../src/submissions.js";
import { type Fixture, makeSite, PASSWORD, SECRET, signedIn } from "./site.js";

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text }
collections:
  posts:
    path: content/posts
    format: json
    slug: title
    fields:
      title: { type: text, required: true }
`;
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef01234567";
const ORIGIN = "https://studio.example.com";
const ALPHA = "site-1";
const BETA = "site-2";

interface Account {
  id: number;
  login: string;
  name: string | null;
}
const PEOPLE: Record<string, Account> = {
  ada: { id: 101, login: "ada", name: "Ada Lovelace" },
  ghopper: { id: 202, login: "ghopper", name: "Grace Hopper" },
  mallory: { id: 303, login: "mallory", name: null },
  boss: { id: 1, login: "boss", name: "The Boss" },
};

let dir: string;
let file: string;
let alpha: Fixture;
let beta: Fixture;
let app: ReturnType<typeof createApp>;
let github: GitHub;
let calls: Array<{ method: string; url: string; auth: string; body: string }>;
/** `login -> repository -> permission`, as GitHub would answer. */
let permissions: Record<string, Record<string, string>>;
/** The account GitHub now has under a login, when it is no longer the one who signed in. */
let renamed: Record<string, number>;
/** The repositories the owner chose for the app. */
let given: string[];

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

const fakeGitHub: typeof fetch = async (input, init) => {
  const asked = String(input);
  const url = new URL(asked.replace("/api/v3/", "/"));
  const method = init?.method ?? "GET";
  const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
  calls.push({ method, url: asked, auth, body: String(init?.body ?? "") });
  if (url.pathname === "/app-manifests/good-code/conversions") {
    return json({
      id: 7,
      slug: "greatcms-studio",
      client_id: "Iv1.abc",
      client_secret: CLIENT_SECRET,
      pem: keys.privateKey,
      html_url: `${url.hostname === "api.github.com" ? "https://github.com" : url.origin}/apps/greatcms-studio`,
      owner: { login: "boss", type: "User", id: 1 },
    });
  }
  if (url.pathname === "/login/oauth/access_token") {
    const sent = JSON.parse(String(init?.body)) as Record<string, string>;
    const login = /^code-(\w+)$/.exec(sent.code ?? "")?.[1];
    if (!login || !PEOPLE[login] || sent.client_secret !== CLIENT_SECRET) {
      return json({ error: "bad_verification_code" });
    }
    return json({ access_token: `ghu_token_of_${login}_0123456789`, token_type: "bearer" });
  }
  if (url.pathname === "/user") {
    const login = /^Bearer ghu_token_of_(\w+)_0123456789$/.exec(auth)?.[1];
    const person = login ? PEOPLE[login] : undefined;
    if (!person) return json({ message: "Bad credentials" }, 401);
    return json({ ...person, type: "User", email: `${person.login}@private.example` });
  }
  if (url.pathname === "/applications/Iv1.abc/token" && method === "DELETE") return json(null, 204);
  if (url.pathname === "/app/installations" && method === "GET") {
    return json([{ id: 11, account: { login: "acme" } }]);
  }
  if (url.pathname === "/app/installations/11/access_tokens") {
    return json({
      token: "ghs_installation",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
  }
  if (url.pathname === "/app/installations/11" && method === "DELETE") return json(null, 204);
  if (url.pathname === "/installation/repositories") {
    return json({
      repositories: given.map((name) => ({
        full_name: `acme/${name}`,
        name,
        owner: { login: "acme" },
        clone_url: `https://github.com/acme/${name}.git`,
        private: false,
        default_branch: "main",
      })),
    });
  }
  const about = /^\/repos\/acme\/(\w+)\/collaborators\/(\w+)\/permission$/.exec(url.pathname);
  if (about && auth === "token ghs_installation") {
    const [, repository, login] = about as unknown as [string, string, string];
    const permission = permissions[login]?.[repository];
    if (!permission) return json({ message: "Not Found" }, 404);
    return json({
      permission,
      role_name: permission,
      user: { login, id: renamed[login] ?? PEOPLE[login]?.id },
    });
  }
  return json({ message: "Not Found" }, 404);
};

const ORIGINS = () =>
  new Map([
    [alpha.root, "https://github.com/acme/alpha.git"],
    [beta.root, "git@github.com:acme/beta.git"],
  ]);

function studio(extra: Partial<AppOptions> = {}) {
  const origins = ORIGINS();
  return createApp({
    store: alpha.store,
    password: PASSWORD,
    secret: SECRET,
    publicUrl: ORIGIN,
    github,
    originOf: async (path) => origins.get(path) ?? null,
    ...extra,
  });
}

/** The app as GitHub hands it back, with or without the client secret a newer one comes with. */
async function connect(target: GitHub = github) {
  const { action } = target.creation(ORIGIN);
  await target.finishCreation("good-code", new URL(action).searchParams.get("state") as string);
}

const cookieOf = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .find((value) => value.startsWith(`${name}=`) && value !== `${name}=`);

/** Goes to GitHub and comes back, as a browser would; returns the callback's answer. */
async function roundTrip(
  login: string,
  options: { next?: string; cookie?: string; target?: ReturnType<typeof createApp> } = {},
) {
  const target = options.target ?? app;
  const start = await target.request(
    `/sign-in/github${options.next ? `?next=${encodeURIComponent(options.next)}` : ""}`,
  );
  const authorize = new URL(start.headers.get("location") as string);
  const trip = cookieOf(start, "greatcms_github") as string;
  const callback = await target.request(
    `/sign-in/github/callback?code=code-${login}&state=${authorize.searchParams.get("state")}`,
    { headers: { cookie: [trip, options.cookie].filter(Boolean).join("; ") } },
  );
  return { start, authorize, trip, callback };
}

async function signInAs(login: string, target = app): Promise<{ cookie: string }> {
  const { callback } = await roundTrip(login, { target });
  expect(callback.status, await callback.clone().text()).toBe(303);
  return { cookie: cookieOf(callback, "greatcms_session") as string };
}

const form = { "content-type": "application/x-www-form-urlencoded" };
const post = (path: string, who: { cookie: string }, fields: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { ...who, ...form },
    body: new URLSearchParams(fields),
  });
const get = (path: string, who: { cookie: string }) => app.request(path, { headers: who });
const text = async (response: Response | Promise<Response>) => (await response).text();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "greatcms-github-sign-in-"));
  file = join(dir, "git", "github-app.json");
  calls = [];
  renamed = {};
  given = ["alpha", "beta"];
  permissions = { ada: { alpha: "write" }, ghopper: { beta: "admin" }, boss: {} };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the sites it fills
  const files = (name: string) => ({
    "content/cms/home.hero.json": JSON.stringify({ heading: `${name} secret heading` }),
    "content/posts/hello.json": JSON.stringify({ title: `${name} secret post` }),
  });
  alpha = makeSite({
    schema: SCHEMA,
    files: files("Alpha"),
    devUrl: "https://alpha-preview.example.com",
  });
  beta = makeSite({ schema: SCHEMA, files: files("Beta") });
  alpha.store.updateSite(ALPHA, {
    name: "Alpha Site",
    devUrl: "https://alpha-preview.example.com",
    pushAfterPublish: false,
    deployRoot: "",
  });
  alpha.store.addSite({
    id: BETA,
    name: "Beta Site",
    path: beta.root,
    devUrl: "https://beta-preview.example.com",
    createdAt: "2026-08-16",
  });
  github = new GitHub(file, undefined, fakeGitHub);
  await connect();
  app = studio();
});

afterEach(() => {
  vi.restoreAllMocks();
  alpha.cleanup();
  beta.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("the app that signs people in", () => {
  it("asks GitHub to send people back to this studio, and keeps its secret to itself", async () => {
    const manifest = JSON.parse(github.creation(ORIGIN).manifest);
    expect(manifest.callback_urls).toEqual([`${ORIGIN}/sign-in/github/callback`]);
    expect(manifest.request_oauth_on_install).toBe(false);
    expect(github.signIn()).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const page = await text(get("/git-access", signedIn));
    expect(page).toContain("Signing in with GitHub");
    expect(page).not.toContain(CLIENT_SECRET);
    expect(page).not.toContain("BEGIN RSA");
    expect(
      new JSDOM(page).window.document.querySelector("#github-sign-in ~ p code")?.textContent,
    ).toBe("boss");
  });

  it("works on GitHub Enterprise Server, at its own address", async () => {
    const server = new GitHub(join(dir, "ghes.json"), "https://git.example.com/", fakeGitHub);
    await connect(server);
    const url = new URL(server.authorizeUrl(`${ORIGIN}/cb`, "s", "c") as string);
    expect(url.origin + url.pathname).toBe("https://git.example.com/login/oauth/authorize");
    await server.identify("code-ada", `${ORIGIN}/cb`, "v".repeat(43));
    expect(calls.map((call) => call.url)).toEqual(
      expect.arrayContaining([
        "https://git.example.com/login/oauth/access_token",
        "https://git.example.com/api/v3/user",
      ]),
    );
  });
});

describe("an app made before sign-in existed", () => {
  beforeEach(() => {
    const { clientSecret: _, ...old } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
  });

  it("keeps copying and pushing, and offers no GitHub sign-in", async () => {
    expect(github.signIn()).toBe(false);
    expect(await github.installations()).toHaveLength(1);
    expect(await text(app.request("/sign-in"))).not.toContain("/sign-in/github");
    expect((await app.request("/sign-in/github")).status).toBe(404);
    expect((await app.request("/sign-in/github/callback?code=code-ada&state=x")).status).toBe(404);
  });

  it("says exactly what to add on GitHub, and turns sign-in on once the secret is saved", async () => {
    const page = new JSDOM(await text(get("/git-access", signedIn))).window.document;
    const steps = page.querySelector("#github-sign-in ~ ol")?.textContent ?? "";
    expect(steps).toContain(`${ORIGIN}/sign-in/github/callback`);
    expect(steps).toContain("generate a new client secret");
    expect(page.querySelector("#github-sign-in ~ ol a")?.getAttribute("href")).toBe(
      "https://github.com/settings/apps/greatcms-studio",
    );

    const refused = await post("/git-access/github/secret", signedIn, { secret: "short" });
    expect(refused.status).toBe(422);
    expect(github.signIn()).toBe(false);

    const saved = await post("/git-access/github/secret", signedIn, { secret: CLIENT_SECRET });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(CLIENT_SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await text(app.request("/sign-in"))).toContain('href="/sign-in/github"');
    expect((await signInAs("ada")).cookie).toBeTruthy();
  });

  it("takes the secret from the owner alone", async () => {
    alpha.store.addEditor({
      name: "Ed",
      email: "ed@example.com",
      passwordHash: hashPassword("a long enough password"),
    });
    const signIn = await app.request("/sign-in", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ email: "ed@example.com", password: "a long enough password" }),
    });
    const editor = { cookie: cookieOf(signIn, "greatcms_session") as string };
    const tried = await post("/git-access/github/secret", editor, { secret: CLIENT_SECRET });
    expect(tried.status).toBe(403);
    expect(github.signIn()).toBe(false);
  });
});

describe("the sign-in page", () => {
  it("offers GitHub as a plain link above the password, in valid HTML with no script", async () => {
    const body = await text(app.request("/sign-in?next=%2Fsites%2Fsite-1"));
    const page = new JSDOM(body).window.document;
    const link = page.querySelector(".sign-in-github a") as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe("Continue with GitHub");
    expect(link.getAttribute("href")).toBe("/sign-in/github?next=%2Fsites%2Fsite-1");
    expect(
      link.compareDocumentPosition(page.querySelector("form[action='/sign-in']") as Node) & 4, // DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(page.querySelectorAll("script")).toHaveLength(0);
    expect(page.querySelectorAll("img")).toHaveLength(0);

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

  it("keeps the button after a wrong password, and leaves form-action as it was", async () => {
    const wrong = await app.request("/sign-in", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ password: "nope" }),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("/sign-in/github");
    const csp = (await app.request("/sign-in")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self';");
    expect(csp).not.toContain("github.com");
  });

  it("shows none of it in local mode", async () => {
    const local = studio({ local: true });
    expect(await text(local.request("/sign-in"))).not.toContain("/sign-in/github");
    expect((await local.request("/sign-in/github")).status).toBe(404);
    expect((await local.request("/sign-in/github/callback?code=code-ada&state=x")).status).toBe(
      404,
    );
  });
});

describe("the trip to GitHub and back", () => {
  it("signs a person in as who GitHub says they are, and keeps nothing of their token", async () => {
    const { start, authorize, callback } = await roundTrip("ada");
    expect(start.status).toBe(302);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/sign-in/github/callback`);
    expect(authorize.searchParams.has("scope")).toBe(false);
    expect(authorize.href).not.toContain(CLIENT_SECRET);
    expect(start.headers.getSetCookie()[0]).toMatch(
      /^greatcms_github=[^;]+; Path=\/sign-in\/github; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`/sites/${ALPHA}`);
    // The trip's cookie is spent, and the session is a new one.
    expect(callback.headers.getSetCookie().join("\n")).toMatch(/greatcms_github=; .*Max-Age=0/);
    const cookie = cookieOf(callback, "greatcms_session") as string;
    expect(decodeURIComponent(cookie)).toMatch(/^greatcms_session=github:101\./);

    const exchange = calls.find((call) => call.url.endsWith("/login/oauth/access_token"))!;
    const sent = JSON.parse(exchange.body) as Record<string, string>;
    // PKCE: what went out with the browser is the hash of what only the server sends.
    expect(createHash("sha256").update(sent.code_verifier!).digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    // The token is given up at GitHub, and no trace of it or of an email is stored.
    await vi.waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "DELETE" &&
            call.url.endsWith("/applications/Iv1.abc/token") &&
            call.body.includes("ghu_token_of_ada"),
        ),
      ).toBe(true),
    );
    expect(alpha.store.getGithubPerson(101)).toMatchObject({ login: "ada", name: "Ada Lovelace" });
    expect(JSON.stringify(alpha.store.getGithubPerson(101))).not.toMatch(/ghu_|@/);

    const page = await text(get(`/sites/${ALPHA}`, { cookie }));
    expect(new JSDOM(page).window.document.querySelector(".signed-in")?.textContent?.trim()).toBe(
      "Ada Lovelace",
    );
    expect(page).not.toMatch(/<img[^>]+(avatars|github)/i);
    expect(page).not.toContain("private.example");
  });

  it("goes on to the page that was asked for, and nowhere outside the studio", async () => {
    const inside = await roundTrip("ada", { next: `/sites/${ALPHA}/regions/home.hero` });
    expect(inside.callback.headers.get("location")).toBe(`/sites/${ALPHA}/regions/home.hero`);
    for (const next of ["https://evil.example/", "//evil.example", "/\\evil.example"]) {
      // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
      const outside = await roundTrip("ada", { next });
      expect(outside.callback.headers.get("location")).toBe(`/sites/${ALPHA}`);
    }
  });

  it("shows where a site's folder is to an owner, and not to someone GitHub let in", async () => {
    const folder = alpha.root.split("/").at(-1) as string;
    const ada = await signInAs("ada");
    for (const path of ["/", `/sites/${ALPHA}`]) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time keeps the failure readable
      const shown = await text(get(path, ada));
      expect(shown, path).toContain("Alpha Site");
      expect(shown, path).not.toContain(folder);
      // oxlint-disable-next-line no-await-in-loop
      expect(await text(get(path, signedIn)), path).toContain(`title="${alpha.root}"`);
    }
    const boss = await signInAs("boss");
    expect(await text(get(`/sites/${ALPHA}`, boss))).toContain(`title="${alpha.root}"`);
  });

  it("refuses an answer that this browser did not ask for", async () => {
    const { authorize, trip } = await roundTrip("ada");
    const state = authorize.searchParams.get("state");
    const attempts: Array<[string, string | undefined]> = [
      [`code=code-ada&state=${state}`, undefined],
      ["code=code-ada&state=forged", trip],
      ["code=code-ada", trip],
      [`code=code-ada&state=${state}`, `${trip}x`],
    ];
    for (const [query, cookie] of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- each is its own request
      const answer = await app.request(`/sign-in/github/callback?${query}`, {
        headers: cookie ? { cookie } : {},
      });
      expect(answer.status, query).toBe(400);
      expect(cookieOf(answer, "greatcms_session"), query).toBeUndefined();
    }
  });

  it("signs nobody in from the same answer twice", async () => {
    const { authorize, trip, callback } = await roundTrip("ada");
    expect(callback.status).toBe(303);
    const again = await app.request(
      `/sign-in/github/callback?code=code-ada&state=${authorize.searchParams.get("state")}`,
      { headers: { cookie: trip } },
    );
    expect(again.status).toBe(400);
    expect(cookieOf(again, "greatcms_session")).toBeUndefined();
  });

  it("gives up on a trip that took more than ten minutes", async () => {
    const start = await app.request("/sign-in/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    const late = await app.request(`/sign-in/github/callback?code=code-ada&state=${state}`, {
      headers: { cookie: cookieOf(start, "greatcms_github") as string },
    });
    expect(late.status).toBe(400);
  });

  it("repeats nothing GitHub puts in the address when it refuses", async () => {
    const start = await app.request("/sign-in/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const denied = await app.request(
      `/sign-in/github/callback?error=access_denied&error_description=%3Cb%3Ecall+0800+now%3C%2Fb%3E&state=${state}`,
      { headers: { cookie: cookieOf(start, "greatcms_github") as string } },
    );
    expect(denied.status).toBe(400);
    const body = await denied.text();
    expect(body).not.toContain("0800");
    expect(body).toContain("GitHub did not sign you in");
    expect(cookieOf(denied, "greatcms_session")).toBeUndefined();
  });

  it("signs nobody in on a code GitHub does not know", async () => {
    const { callback } = await roundTrip("nobody");
    expect(callback.status).toBe(400);
    expect(cookieOf(callback, "greatcms_session")).toBeUndefined();
  });

  it("stops answering an address that keeps failing", async () => {
    app = studio({ signInLimiter: new RateLimiter(3, 60_000) });
    for (let attempt = 0; attempt < 3; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- counted one after another
      expect((await app.request("/sign-in/github/callback?code=x&state=y")).status).toBe(400);
    }
    const limited = await app.request("/sign-in/github/callback?code=x&state=y");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("retires the session a browser arrived with", async () => {
    const first = await signInAs("ada");
    const { callback } = await roundTrip("ghopper", { cookie: first.cookie });
    expect(callback.status).toBe(303);
    const second = cookieOf(callback, "greatcms_session");
    expect(second).not.toBe(first.cookie);
    const old = await get("/", first);
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("/sign-in");
  });

  it("signs everyone GitHub let in out when the owner disconnects GitHub", async () => {
    const ada = await signInAs("ada");
    expect((await get(`/sites/${ALPHA}`, ada)).status).toBe(200);
    expect((await post("/git-access/github/delete", signedIn)).status).toBe(200);
    expect((await get(`/sites/${ALPHA}`, ada)).headers.get("location")).toBe("/sign-in");
    // Connected again, the old session is still not one of the new app's.
    await connect();
    expect((await get(`/sites/${ALPHA}`, ada)).headers.get("location")).toBe("/sign-in");
    expect((await get("/", signedIn)).status).toBe(200);
  });
});

describe("access follows GitHub", () => {
  it("opens exactly the sites whose repository the person can push to", async () => {
    const ada = await signInAs("ada");
    const home = new JSDOM(await text(get("/", ada))).window.document;
    expect([...home.querySelectorAll(".site-card h2")].map((node) => node.textContent)).toEqual([
      "Alpha Site",
    ]);
    expect((await get(`/sites/${ALPHA}`, ada)).status).toBe(200);
    expect((await get(`/sites/${BETA}`, ada)).status).toBe(404);
    // Asked of GitHub as the app, about the login GitHub itself gave at sign-in.
    const asked = calls.filter((call) => call.url.includes("/collaborators/"));
    expect(asked.every((call) => call.auth === "token ghs_installation")).toBe(true);
    expect(asked.map((call) => new URL(call.url).pathname)).toEqual(
      expect.arrayContaining([
        "/repos/acme/alpha/collaborators/ada/permission",
        "/repos/acme/beta/collaborators/ada/permission",
      ]),
    );
  });

  it("counts read access, a site with no GitHub origin, and a reused login as no access", async () => {
    permissions.mallory = { alpha: "read", beta: "triage" };
    const mallory = await signInAs("mallory");
    expect((await get(`/sites/${ALPHA}`, mallory)).status).toBe(404);

    const elsewhere = studio({ originOf: async () => "https://gitlab.com/acme/alpha.git" });
    const ada = await signInAs("ada", elsewhere);
    expect((await elsewhere.request(`/sites/${ALPHA}`, { headers: ada })).status).toBe(404);

    // The login now belongs to another account: its permission is not this person's.
    renamed.ghopper = 999;
    const grace = await signInAs("ghopper");
    expect((await get(`/sites/${BETA}`, grace)).status).toBe(404);
  });

  it("opens nothing in a repository the app was not given, whoever can push to it", async () => {
    given = ["alpha"];
    const grace = await signInAs("ghopper");
    expect((await get(`/sites/${BETA}`, grace)).status).toBe(404);
    expect(calls.some((call) => call.url.includes("/repos/acme/beta/"))).toBe(false);
  });

  it("asks GitHub again after a minute or two, and at once for a publish", async () => {
    const ada = await signInAs("ada");
    expect((await get(`/sites/${ALPHA}`, ada)).status).toBe(200);
    const before = calls.filter((call) => call.url.includes("/collaborators/")).length;
    expect((await get(`/sites/${ALPHA}/regions/home.hero`, ada)).status).toBe(200);
    expect(calls.filter((call) => call.url.includes("/collaborators/")).length).toBe(before);

    permissions.ada = {};
    // Reading still rides the last answer; publishing does not.
    expect((await get(`/sites/${ALPHA}`, ada)).status).toBe(200);
    const head = alpha.head();
    const publish = await post(`/sites/${ALPHA}/regions/home.hero`, ada, {
      "f[heading]": "Changed after losing access",
      headSha: head,
    });
    expect(publish.status).toBe(404);
    expect(alpha.head()).toBe(head);
    // The refusal is itself an answer, so reading ends with it.
    expect((await get(`/sites/${ALPHA}`, ada)).status).toBe(404);
  });

  it("ends reading too once the answer is two minutes old", async () => {
    const ada = await signInAs("ada");
    expect((await get(`/sites/${ALPHA}`, ada)).status).toBe(200);
    permissions.ada = {};
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * 60_000);
    expect((await get(`/sites/${ALPHA}`, ada)).status).toBe(404);
    expect(await text(get("/", ada))).toContain("No sites to edit");
  });

  it("does not publish a scheduled change for someone who has lost access since", async () => {
    const ada = await signInAs("ada");
    const head = alpha.head();
    const scheduled = await post(`/sites/${ALPHA}/regions/home.hero`, ada, {
      "f[heading]": "Later",
      headSha: head,
      action: "schedule",
      publishAt: "2099-01-01T09:00",
    });
    expect(scheduled.status).toBe(303);
    permissions.ada = {};
    await app.runDueSchedules(Date.parse("2100-01-01"));
    const [job] = alpha.store.listScheduled(ALPHA);
    expect(job?.status).toBe("failed");
    expect(job?.detail).toBe("The person who scheduled it can no longer open this site.");
    expect(alpha.head()).toBe(head);
  });

  it("publishes as the person, under the address GitHub gives every account", async () => {
    const ada = await signInAs("ada");
    const publish = await post(`/sites/${ALPHA}/regions/home.hero`, ada, {
      "f[heading]": "Edited by Ada",
      headSha: alpha.head(),
    });
    expect(publish.status).toBe(200);
    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: alpha.root,
      encoding: "utf8",
    }).trim();
    expect(author).toBe("Ada Lovelace <101+ada@users.noreply.github.com>");
  });

  it("gives someone with no site a plain page saying how access is given, and nothing else", async () => {
    const mallory = await signInAs("mallory");
    const home = await get("/", mallory);
    expect(home.status).toBe(200);
    const page = new JSDOM(await home.text()).window.document;
    expect(page.querySelector("h1")?.textContent).toBe("No sites to edit");
    expect(page.body.textContent).toContain("write access");
    expect(page.querySelector("form[action='/sign-out'] button")).toBeTruthy();
    expect(page.querySelector(".sidebar")).toBeNull();
    expect(page.body.textContent).not.toMatch(/Alpha|Beta|connect a site|host/i);

    expect((await get("/sites/new", mallory)).status).toBe(403);
    expect((await post("/sites", mallory, { path: alpha.root, name: "Mine" })).status).toBe(403);
    expect(
      (await post("/sites/clone", mallory, { url: "https://github.com/x/y.git" })).status,
    ).toBe(403);
    expect(alpha.store.listSites()).toHaveLength(2);
    expect(await text(get("/inbox", mallory))).not.toMatch(/Alpha|Beta/);
  });
});

describe("owners", () => {
  it("makes the account that owns the app an owner, and no one else", async () => {
    const boss = await signInAs("boss");
    const home = new JSDOM(await text(get("/", boss))).window.document;
    expect(home.querySelectorAll(".site-card")).toHaveLength(2);
    expect(home.querySelector(".signed-in")?.textContent?.trim()).toBe("The Boss");
    for (const path of ["/editors", "/git-access", "/sites/new", `/sites/${BETA}/settings`]) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      expect((await get(path, boss)).status, path).toBe(200);
    }
    const ada = await signInAs("ada");
    for (const path of ["/editors", "/git-access", "/sites/new", `/sites/${ALPHA}/settings`]) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      expect((await get(path, ada)).status, path).toBe(403);
    }
  });

  it("goes by the account's id, so a login taken over later owns nothing", async () => {
    PEOPLE.boss = { id: 4242, login: "boss", name: "An Impostor" };
    try {
      const impostor = await signInAs("boss");
      expect((await get("/editors", impostor)).status).toBe(403);
      expect(await text(get("/", impostor))).toContain("No sites to edit");
    } finally {
      PEOPLE.boss = { id: 1, login: "boss", name: "The Boss" };
    }
  });

  it("takes the owners from STUDIO_GITHUB_OWNERS when it is set", async () => {
    app = studio({ githubOwners: [" Ada ", ""] });
    expect((await get("/editors", await signInAs("ada"))).status).toBe(200);
    expect((await get("/editors", await signInAs("boss"))).status).toBe(403);
    expect(await text(get("/git-access", signedIn))).toContain("<code>ada</code>");
  });
});

describe("two people, each seeing only their own things", () => {
  let ada: { cookie: string };
  let grace: { cookie: string };
  let alphaMessage: number;
  let betaMessage: number;

  beforeEach(async () => {
    alpha.store.addEditor({
      name: "Eve Editor",
      email: "eve@example.com",
      passwordHash: hashPassword("a long enough password"),
    });
    alphaMessage = alpha.store.addSubmission({
      siteId: ALPHA,
      form: "contact",
      data: { message: "A note for alpha", email: "visitor-a@example.com" },
      spamScore: 0,
      spamReasons: [],
    });
    betaMessage = alpha.store.addSubmission({
      siteId: BETA,
      form: "contact",
      data: { message: "A note for beta", email: "visitor-b@example.com" },
      spamScore: 0,
      spamReasons: [],
    });
    ada = await signInAs("ada");
    grace = await signInAs("ghopper");
  });

  /** Every address under a site, with what a person who can open the site gets from it. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the tests that use it
  const reads = (site: string): Array<[string, number]> => [
    [`/sites/${site}`, 200],
    [`/sites/${site}/regions/home.hero`, 200],
    [`/sites/${site}/regions/home.hero/history`, 200],
    [`/sites/${site}/collections/posts`, 200],
    [`/sites/${site}/collections/posts/hello`, 200],
    [`/sites/${site}/collections/posts/new`, 200],
    [`/sites/${site}/collections/posts/hello/history`, 200],
    [`/sites/${site}/search?q=secret`, 200],
    [`/sites/${site}/icon`, 200],
  ];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the tests that use it
  const writes = (site: string, head: string): Array<[string, Record<string, string>]> => [
    [`/sites/${site}/regions/home.hero`, { "f[heading]": "Taken over", headSha: head }],
    [`/sites/${site}/regions/home.hero/draft`, { "f[heading]": "Draft taken over", headSha: head }],
    [`/sites/${site}/regions/home.hero/draft/discard`, {}],
    [
      `/sites/${site}/regions/home.hero`,
      { "f[heading]": "Later", headSha: head, action: "schedule", publishAt: "2099-01-01T09:00" },
    ],
    [`/sites/${site}/regions/home.hero/history/${head}/restore`, {}],
    [`/sites/${site}/collections/posts/hello`, { "f[title]": "Taken over", headSha: head }],
    [`/sites/${site}/collections/posts/new`, { "f[title]": "Planted" }],
    [`/sites/${site}/collections/posts/hello/draft`, { "f[title]": "Draft taken over" }],
    [`/sites/${site}/collections/posts/hello/draft/discard`, {}],
    [`/sites/${site}/collections/posts/hello/history/${head}/restore`, {}],
    [`/sites/${site}/collections/posts/hello/delete`, {}],
    [`/sites/${site}/push`, {}],
    [`/sites/${site}/rollback`, { sha: head }],
    [`/sites/${site}/share`, { path: "/" }],
    [`/sites/${site}/scheduled/1/cancel`, {}],
  ];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the tests that use it
  const state = (site: Fixture) =>
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: site.root,
      encoding: "utf8",
    }) + site.head();

  it("opens every screen of their own site and none of the other's", async () => {
    for (const [who, own, other] of [
      [ada, ALPHA, BETA],
      [grace, BETA, ALPHA],
    ] as const) {
      for (const [path, status] of reads(own)) {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        expect((await get(path, who)).status, path).toBe(status);
      }
      for (const [path] of [
        ...reads(other),
        [`/sites/${other}/media/photo.png`],
        [`/sites/${other}/pending-media/token/0?scope=region:home.hero`],
      ] as Array<[string]>) {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        const answer = await get(path, who);
        expect(answer.status, path).toBe(404);
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        expect(await answer.text(), path).not.toMatch(/Alpha|Beta|secret/);
      }
    }
  });

  it("changes nothing in the other's site, by any form", async () => {
    alpha.store.schedule({
      siteId: BETA,
      target: "regions/home.hero",
      label: "home.hero",
      form: [["heading", "Scheduled by Grace"]],
      dueAt: Date.parse("2099-01-01"),
      actor: "github:202",
      author: null,
    });
    const before = state(beta);
    for (const [path, fields] of writes(BETA, beta.head())) {
      // oxlint-disable-next-line no-await-in-loop -- one form at a time
      expect((await post(path, ada, fields)).status, path).toBe(404);
    }
    expect(state(beta)).toBe(before);
    expect(alpha.store.listScheduled(BETA).map((job) => job.status)).toEqual(["waiting"]);
    // Settings and removal are the owner's, on their own site as much as on another's.
    for (const site of [ALPHA, BETA]) {
      for (const path of [`/sites/${site}/settings`, `/sites/${site}/delete`]) {
        // oxlint-disable-next-line no-await-in-loop -- one form at a time
        expect((await post(path, ada, { name: "Renamed" })).status, path).toBe(403);
      }
    }
    expect(alpha.store.listSites().map((site) => site.name)).toEqual(["Alpha Site", "Beta Site"]);
  });

  it("can do all of that on their own site", async () => {
    const answers: Record<string, number> = {};
    for (const [path, fields] of writes(BETA, beta.head()).slice(0, 3)) {
      // oxlint-disable-next-line no-await-in-loop -- one form at a time
      answers[path] = (await post(path, grace, fields)).status;
    }
    expect(Object.values(answers)).toEqual([200, 204, 303]);
    expect(beta.read("content/cms/home.hero.json")).toContain("Taken over");
  });

  it("lists, counts, exports and acts on only their own sites' submissions", async () => {
    for (const [who, mine, theirs, theirId, other] of [
      [ada, "A note for alpha", "A note for beta", betaMessage, BETA],
      [grace, "A note for beta", "A note for alpha", alphaMessage, ALPHA],
    ] as const) {
      for (const path of ["/inbox", "/inbox?spam=1", `/inbox?site=${other}`, "/inbox.csv"]) {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        const body = await text(get(path, who));
        expect(body, path).not.toContain(theirs);
        expect(body, path).not.toContain(`visitor-${other === BETA ? "b" : "a"}@example.com`);
        if (!path.includes("site=")) expect(body, path).toContain(mine);
      }
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const inbox = new JSDOM(await text(get("/inbox", who))).window.document;
      expect(inbox.querySelectorAll("#site option")).toHaveLength(2);
      expect(inbox.querySelector(".sidebar .count")?.textContent).toContain("1");
      // oxlint-disable-next-line no-await-in-loop -- one form at a time
      expect((await post(`/inbox/${theirId}/read`, who, { read: "1" })).status).toBe(404);
      // oxlint-disable-next-line no-await-in-loop -- one form at a time
      expect((await post(`/inbox/${theirId}/delete`, who)).status).toBe(404);
      expect(alpha.store.getSubmission(theirId)?.readAt).toBeNull();
    }
    expect((await post(`/inbox/${alphaMessage}/read`, ada, { read: "1" })).status).toBe(303);
    expect(alpha.store.getSubmission(alphaMessage)?.readAt).toBeTruthy();
    expect((await post(`/inbox/${alphaMessage}/delete`, ada)).status).toBe(303);
    expect(alpha.store.getSubmission(alphaMessage)).toBeNull();
    // The owner still sees every site's.
    expect(await text(get("/inbox", signedIn))).toContain("A note for beta");
  });

  it("opens the preview of their own site and not the other's", async () => {
    const check = (who: { cookie: string }, host: string) =>
      app.request("/auth/check", {
        headers: { ...who, "x-forwarded-host": host, "x-forwarded-proto": "https" },
      });
    expect((await check(ada, "alpha-preview.example.com")).status).toBe(204);
    expect((await check(ada, "beta-preview.example.com")).status).toBe(403);
    expect((await check(grace, "beta-preview.example.com")).status).toBe(204);
    expect((await check(grace, "alpha-preview.example.com")).status).toBe(403);
    expect((await check(signedIn, "beta-preview.example.com")).status).toBe(204);
  });

  it("shows who else is here by name, never by email or login", async () => {
    const signIn = await app.request("/sign-in", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ email: "eve@example.com", password: "a long enough password" }),
    });
    const eve = { cookie: cookieOf(signIn, "greatcms_session") as string };
    // Eve, an editor with a password, and the owner both have Alpha's hero open; so did Grace's
    // account once, when it could still push there.
    await get(`/sites/${ALPHA}/regions/home.hero`, eve);
    await get(`/sites/${ALPHA}/regions/home.hero`, signedIn);
    permissions.ghopper = { alpha: "write", beta: "admin" };
    // The owner's "Check again" is what makes new access show before the minute is up.
    await post("/git-access/github/refresh", signedIn);
    const published = await post(`/sites/${ALPHA}/regions/home.hero`, grace, {
      "f[heading]": "Grace was here",
      headSha: alpha.head(),
    });
    expect(published.status).toBe(200);
    const scheduled = await post(`/sites/${ALPHA}/regions/home.hero`, eve, {
      "f[heading]": "Eve was here",
      headSha: alpha.head(),
      action: "schedule",
      publishAt: "2099-01-01T09:00",
    });
    expect(scheduled.status).toBe(303);

    const pages = [
      "/",
      "/inbox",
      `/sites/${ALPHA}`,
      `/sites/${ALPHA}/regions/home.hero`,
      `/sites/${ALPHA}/regions/home.hero/history`,
      `/sites/${ALPHA}/collections/posts`,
      `/sites/${ALPHA}/search?q=here`,
    ];
    let seen = "";
    for (const path of pages) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const body = await text(get(path, ada));
      seen += body;
      expect(body, path).not.toMatch(/eve@example\.com|ghopper|users\.noreply|private\.example/);
    }
    // Names are what is shown: who is also here, who published, who scheduled.
    expect(seen).toContain("Eve Editor");
    expect(seen).toContain("Grace Hopper");
    // And an editor with a password sees no GitHub login either.
    for (const path of pages) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      expect(await text(get(path, eve)), path).not.toMatch(/ghopper|101\+ada|users\.noreply/);
    }
  });

  it("keeps the Editors page, with its emails, to owners", async () => {
    for (const who of [ada, grace]) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const answer = await get("/editors", who);
      expect(answer.status).toBe(403);
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      expect(await answer.text()).not.toContain("eve@example.com");
    }
    expect(await text(get("/editors", signedIn))).toContain("eve@example.com");
  });
});

/** Editors with a password open only the sites the owner ticked for them. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HtmlValidate } from "html-validate";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { Store } from "../src/db.js";
import { type Fixture, makeSite, PASSWORD, SECRET, signedIn } from "./site.js";

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
const ORIGIN = "https://studio.example.com";
const ALPHA = "site-1";
const BETA = "site-2";
const WORD = "a long enough password";

let alpha: Fixture;
let beta: Fixture;
let app: ReturnType<typeof createApp>;

const form = { "content-type": "application/x-www-form-urlencoded" };
const post = (
  path: string,
  who: { cookie: string },
  fields: Record<string, string> | URLSearchParams = {},
) =>
  app.request(path, {
    method: "POST",
    headers: { ...who, ...form },
    body: new URLSearchParams(fields),
  });
const get = (path: string, who: { cookie: string }) => app.request(path, { headers: who });
const text = async (response: Response | Promise<Response>) => (await response).text();

async function signInAs(email: string): Promise<{ cookie: string; response: Response }> {
  const response = await app.request("/sign-in", {
    method: "POST",
    headers: form,
    body: new URLSearchParams({ email, password: WORD }),
  });
  expect(response.status).toBe(303);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .find((value) => value.startsWith("greatcms_session=")) as string;
  return { cookie, response };
}

beforeEach(() => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the sites it fills
  const files = (name: string) => ({
    "content/cms/home.hero.json": JSON.stringify({ heading: `${name} secret heading` }),
    "content/posts/hello.json": JSON.stringify({ title: `${name} secret post` }),
  });
  alpha = makeSite({ schema: SCHEMA, files: files("Alpha") });
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
  app = createApp({ store: alpha.store, password: PASSWORD, secret: SECRET, publicUrl: ORIGIN });
});

afterEach(() => {
  alpha.cleanup();
  beta.cleanup();
});

describe("the Editors page", () => {
  it("offers the sites as checkboxes in plain forms, with no script", async () => {
    alpha.store.addEditor({ name: "Ann", email: "ann@example.com", passwordHash: "x" });
    const body = await text(get("/editors", signedIn));
    expect(body).not.toContain("<script");
    const report = await new HtmlValidate({
      extends: ["html-validate:standard"],
      rules: { "no-inline-style": "off", "no-trailing-whitespace": "off" },
    }).validateString(body);
    expect(report.results.flatMap((result) => result.messages)).toEqual([]);
    const page = new JSDOM(body).window.document;
    for (const selector of ["form[action='/editors']", "form[action='/editors/1/sites']"]) {
      const boxes = [...page.querySelectorAll(`${selector} input[type=checkbox]`)];
      expect(
        boxes.map((box) => [box.getAttribute("name"), box.getAttribute("value")]),
        selector,
      ).toEqual([
        ["all", "1"],
        ["sites", ALPHA],
        ["sites", BETA],
      ]);
      expect(boxes.some((box) => box.hasAttribute("checked"))).toBe(false);
      for (const box of boxes) {
        expect(page.querySelector(`label[for='${box.id}']`), box.id).toBeTruthy();
      }
    }
  });

  it("starts a new editor with the sites ticked in the add form, or with none", async () => {
    const added = await post(
      "/editors",
      signedIn,
      new URLSearchParams([
        ["name", "Ann"],
        ["email", "ann@example.com"],
        ["password", WORD],
        ["sites", BETA],
        ["sites", "no-such-site"],
      ]),
    );
    expect(added.status).toBe(200);
    expect(alpha.store.findEditor("ann@example.com")).toMatchObject({
      allSites: false,
      sites: [BETA],
    });
    const none = await post("/editors", signedIn, {
      name: "Bo",
      email: "bo@example.com",
      password: WORD,
    });
    expect(await none.text()).toContain("They can open no site until you tick one for them.");
    expect(alpha.store.findEditor("bo@example.com")).toMatchObject({ allSites: false, sites: [] });
  });

  it("keeps what was ticked when the add form is refused", async () => {
    const refused = await post("/editors", signedIn, {
      name: "Ann",
      email: "ann@example.com",
      password: "short",
      sites: ALPHA,
    });
    expect(refused.status).toBe(422);
    const page = new JSDOM(await refused.text()).window.document;
    const ticked = [...page.querySelectorAll("form[action='/editors'] input[checked]")];
    expect(ticked.map((box) => box.getAttribute("value"))).toEqual([ALPHA]);
  });

  it("changes an editor's sites, and only for the owner", async () => {
    const ann = alpha.store.addEditor({
      name: "Ann",
      email: "ann@example.com",
      passwordHash: hashPassword(WORD),
      sites: [ALPHA],
    });
    const hers = await signInAs("ann@example.com");
    expect((await post(`/editors/${ann.id}/sites`, hers, { all: "1" })).status).toBe(403);
    expect(alpha.store.getEditor(ann.id)).toMatchObject({ allSites: false, sites: [ALPHA] });

    const saved = await post(`/editors/${ann.id}/sites`, signedIn, { sites: BETA });
    expect(saved.status).toBe(303);
    expect(alpha.store.getEditor(ann.id)).toMatchObject({ allSites: false, sites: [BETA] });
    expect((await get(`/sites/${ALPHA}`, hers)).status).toBe(404);
    expect((await get(`/sites/${BETA}`, hers)).status).toBe(200);
    expect((await post("/editors/999/sites", signedIn, {})).status).toBe(404);
  });

  it("forgets a site's ticks when the site is removed", async () => {
    const ann = alpha.store.addEditor({
      name: "Ann",
      email: "ann@example.com",
      passwordHash: "x",
      sites: [ALPHA, BETA],
    });
    alpha.store.removeSite(BETA);
    expect(alpha.store.getEditor(ann.id)?.sites).toEqual([ALPHA]);
  });
});

describe("editors from before sites were chosen", () => {
  it("keep every site through the upgrade, as a grant the owner can see and take away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "greatcms-editor-sites-"));
    const file = join(dir, "studio.db");
    try {
      const before = new Store(file);
      before.addSite({ id: ALPHA, name: "Alpha Site", path: alpha.root, createdAt: "2026-08-16" });
      before.addSite({ id: BETA, name: "Beta Site", path: beta.root, createdAt: "2026-08-16" });
      before.addEditor({ name: "Old Hand", email: "old@example.com", passwordHash: "x" });
      before.close();
      // The database as the release before left it.
      const raw = new DatabaseSync(file);
      raw.exec(`
        DROP TABLE editor_sites;
        ALTER TABLE editors DROP COLUMN all_sites;
        DELETE FROM migrations WHERE name = '015-editor-sites';
      `);
      raw.close();

      const store = new Store(file);
      const old = store.findEditor("old@example.com");
      expect(old).toMatchObject({ allSites: true, sites: [] });
      const added = store.addEditor({ name: "New", email: "new@example.com", passwordHash: "x" });
      expect(added).toMatchObject({ allSites: false, sites: [] });

      app = createApp({ store, password: PASSWORD, secret: SECRET });
      const page = new JSDOM(await text(get("/editors", signedIn))).window.document;
      const all = page.querySelector(`form[action='/editors/${old!.id}/sites'] input[name=all]`);
      expect(all?.hasAttribute("checked")).toBe(true);
      await post(`/editors/${old!.id}/sites`, signedIn, { sites: ALPHA });
      expect(store.getEditor(old!.id)).toMatchObject({ allSites: false, sites: [ALPHA] });
      store.close();
      // Opening it again changes nothing: the upgrade runs once.
      const again = new Store(file);
      expect(again.findEditor("old@example.com")).toMatchObject({ allSites: false });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("two editors, each seeing only their own things", () => {
  let ann: { cookie: string };
  let ben: { cookie: string };
  let alphaMessage: number;
  let betaMessage: number;

  beforeEach(async () => {
    for (const [name, site] of [
      ["Ann", ALPHA],
      ["Ben", BETA],
    ] as const) {
      alpha.store.addEditor({
        name,
        email: `${name.toLowerCase()}@example.com`,
        passwordHash: hashPassword(WORD),
        sites: [site],
      });
    }
    alpha.store.addEditor({
      name: "Nobody Yet",
      email: "nobody@example.com",
      passwordHash: hashPassword(WORD),
    });
    const message = (siteId: string, note: string, email: string) =>
      alpha.store.addSubmission({
        siteId,
        form: "contact",
        data: { message: note, email },
        spamScore: 0,
        spamReasons: [],
      });
    alphaMessage = message(ALPHA, "A note for alpha", "visitor-a@example.com");
    betaMessage = message(BETA, "A note for beta", "visitor-b@example.com");
    ann = await signInAs("ann@example.com");
    ben = await signInAs("ben@example.com");
  });

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the tests that use it
  const reads = (site: string): string[] => [
    `/sites/${site}`,
    `/sites/${site}/regions/home.hero`,
    `/sites/${site}/regions/home.hero/history`,
    `/sites/${site}/collections/posts`,
    `/sites/${site}/collections/posts/hello`,
    `/sites/${site}/collections/posts/new`,
    `/sites/${site}/collections/posts/hello/history`,
    `/sites/${site}/search?q=secret`,
    `/sites/${site}/icon`,
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
    [`/sites/${site}/share/stop`, {}],
    [`/sites/${site}/scheduled/1/cancel`, {}],
  ];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the tests that use it
  const state = (site: Fixture) =>
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: site.root,
      encoding: "utf8",
    }) + site.head();

  it("lists only their own sites, and goes straight to an only one after signing in", async () => {
    expect(ann.response.headers.get("location")).toBe(`/sites/${ALPHA}`);
    const home = await text(get("/", ben));
    expect(home).toContain("Beta Site");
    expect(home).not.toContain("Alpha");
  });

  it("opens every screen of their own site and none of the other's", async () => {
    for (const [who, own, other] of [
      [ann, ALPHA, BETA],
      [ben, BETA, ALPHA],
    ] as const) {
      for (const path of reads(own)) {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        expect((await get(path, who)).status, path).toBe(200);
      }
      for (const path of [
        ...reads(other),
        `/sites/${other}/media/photo.png`,
        `/sites/${other}/pending-media/token/0?scope=region:home.hero`,
      ]) {
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
      form: [["heading", "Scheduled by Ben"]],
      dueAt: Date.parse("2099-01-01"),
      actor: "editor:2",
      author: null,
    });
    const before = state(beta);
    const round = alpha.store.shareRound(BETA);
    for (const [path, fields] of writes(BETA, beta.head())) {
      // oxlint-disable-next-line no-await-in-loop -- one form at a time
      expect((await post(path, ann, fields)).status, path).toBe(404);
    }
    expect(state(beta)).toBe(before);
    expect(alpha.store.shareRound(BETA)).toBe(round);
    expect(alpha.store.listScheduled(BETA).map((job) => job.status)).toEqual(["waiting"]);
    for (const site of [ALPHA, BETA]) {
      for (const path of [`/sites/${site}/settings`, `/sites/${site}/delete`]) {
        // oxlint-disable-next-line no-await-in-loop -- one form at a time
        expect((await post(path, ann, { name: "Renamed" })).status, path).toBe(403);
      }
    }
    expect(alpha.store.listSites().map((site) => site.name)).toEqual(["Alpha Site", "Beta Site"]);
  });

  it("can do all of that on their own site", async () => {
    const answers: number[] = [];
    for (const [path, fields] of writes(BETA, beta.head()).slice(0, 3)) {
      // oxlint-disable-next-line no-await-in-loop -- one form at a time
      answers.push((await post(path, ben, fields)).status);
    }
    expect(answers).toEqual([200, 204, 303]);
    expect(beta.read("content/cms/home.hero.json")).toContain("Taken over");
    expect((await post(`/sites/${BETA}/share`, ben, { path: "/" })).status).toBe(200);
  });

  it("lists, counts, exports and acts on only their own sites' submissions", async () => {
    for (const [who, mine, theirs, theirId, other] of [
      [ann, "A note for alpha", "A note for beta", betaMessage, BETA],
      [ben, "A note for beta", "A note for alpha", alphaMessage, ALPHA],
    ] as const) {
      for (const path of ["/inbox", "/inbox?spam=1", `/inbox?site=${other}`, "/inbox.csv"]) {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        const body = await text(get(path, who));
        expect(body, path).not.toContain(theirs);
        expect(body, path).not.toContain(`visitor-${other === BETA ? "b" : "a"}@example.com`);
        expect(body, path).not.toContain(other === BETA ? "Beta Site" : "Alpha Site");
        if (!path.includes("site=")) expect(body, path).toContain(mine);
      }
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const inbox = new JSDOM(await text(get("/inbox", who))).window.document;
      expect(inbox.querySelector(".sidebar .count")?.textContent).toContain("1");
      // oxlint-disable-next-line no-await-in-loop -- one form at a time
      expect((await post(`/inbox/${theirId}/read`, who, { read: "1" })).status).toBe(404);
      // oxlint-disable-next-line no-await-in-loop -- one form at a time
      expect((await post(`/inbox/${theirId}/delete`, who)).status).toBe(404);
      expect(alpha.store.getSubmission(theirId)?.readAt).toBeNull();
    }
    expect((await post(`/inbox/${alphaMessage}/read`, ann, { read: "1" })).status).toBe(303);
    expect(await text(get("/inbox", signedIn))).toContain("A note for beta");
  });

  it("opens the preview of their own site and not the other's", async () => {
    const check = (who: { cookie: string }, host: string) =>
      app.request("/auth/check", {
        headers: { ...who, "x-forwarded-host": host, "x-forwarded-proto": "https" },
      });
    expect((await check(ann, "alpha-preview.example.com")).status).toBe(204);
    expect((await check(ann, "beta-preview.example.com")).status).toBe(403);
    expect((await check(ben, "beta-preview.example.com")).status).toBe(204);
    expect((await check(ben, "alpha-preview.example.com")).status).toBe(403);
    expect((await check(signedIn, "beta-preview.example.com")).status).toBe(204);
  });

  it("does not publish a scheduled change for an editor whose site was taken away since", async () => {
    const scheduled = await post(`/sites/${ALPHA}/regions/home.hero`, ann, {
      "f[heading]": "Ann, later",
      headSha: alpha.head(),
      action: "schedule",
      publishAt: "2099-01-01T09:00",
    });
    expect(scheduled.status).toBe(303);
    alpha.store.setEditorSites(1, { allSites: false, sites: [] });
    await app.runDueSchedules(Date.parse("2099-01-02"));
    expect(alpha.read("content/cms/home.hero.json")).not.toContain("Ann, later");
    expect(alpha.store.listScheduled(ALPHA)[0]).toMatchObject({
      status: "failed",
      detail: "The person who scheduled it can no longer open this site.",
    });
  });

  it("gives an editor with no site the plain page, and nothing else", async () => {
    const nobody = await signInAs("nobody@example.com");
    expect(nobody.response.headers.get("location")).toBe("/");
    const home = await get("/", nobody);
    expect(home.status).toBe(200);
    const page = new JSDOM(await home.text()).window.document;
    expect(page.querySelector("h1")?.textContent).toBe("No sites to edit");
    expect(page.querySelector("form[action='/sign-out'] button")).toBeTruthy();
    expect(page.querySelector(".sidebar")).toBeNull();
    expect(page.querySelector("script")).toBeNull();
    expect(page.body.textContent).not.toMatch(/Alpha|Beta|GitHub|nobody@example\.com/i);
    for (const path of [...reads(ALPHA), ...reads(BETA)]) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      expect((await get(path, nobody)).status, path).toBe(404);
    }
    expect(await text(get("/inbox", nobody))).not.toMatch(/Alpha|Beta|A note for/);
    expect(await text(get("/inbox.csv", nobody))).not.toMatch(/A note for|visitor-/);
  });

  it("opens every site for an editor given all of them, including one connected later", async () => {
    alpha.store.setEditorSites(1, { allSites: true, sites: [] });
    const gamma = makeSite({ schema: SCHEMA });
    try {
      alpha.store.addSite({
        id: "site-3",
        name: "Gamma Site",
        path: gamma.root,
        devUrl: "",
        createdAt: "2026-08-16",
      });
      for (const site of [ALPHA, BETA, "site-3"]) {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        expect((await get(`/sites/${site}`, ann)).status, site).toBe(200);
      }
    } finally {
      gamma.cleanup();
    }
  });
});

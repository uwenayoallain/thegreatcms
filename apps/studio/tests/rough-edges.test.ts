/** What a new owner or editor tripped over in a hands-on pass, each one a regression. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { Store } from "../src/db.js";
import { GitAccess } from "../src/git-access.js";
import { LocalRepository } from "../src/repo.js";
import { type Fixture, get, makeSite, PASSWORD, post, SECRET, SITE_ID, signedIn } from "./site.js";

const SCHEMA = `version: 1
blocks:
  feature:
    label: Feature
    fields:
      title: { type: text, required: true }
      icon: { type: select, options: [git, bolt, lock], default: git }
      tone: { type: select, options: [calm, loud] }
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }
      image: { type: image }
  home.features:
    type: blocks
    allow: [feature]
collections:
  blog:
    path: content/blog
    format: markdown
    body: content
    slug: title
    fields:
      title: { type: text, required: true }
      content: { type: richtext }
`;

let site: Fixture;
const temporary: string[] = [];
afterEach(() => {
  site?.cleanup();
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(folder);
  return folder;
};

const page = async (response: Response) => new JSDOM(await response.text()).window.document;

async function editor() {
  site.store.addEditor({
    name: "Ed",
    email: "ed@example.com",
    passwordHash: hashPassword("an editor's long password"),
  });
  const response = await site.app.request("/sign-in", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "ed@example.com", password: "an editor's long password" }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .find((value) => value.startsWith("greatcms_session="));
  return { cookie: cookie as string };
}

describe("what an editor is offered", () => {
  it("leaves out the links only the owner can follow", async () => {
    site = makeSite({ schema: SCHEMA });
    const who = await editor();
    const links = async (path: string, headers: Record<string, string>) =>
      [...(await page(await get(site, path, headers))).querySelectorAll("a")].map(
        (a) => a.getAttribute("href") ?? "",
      );

    const owner = [
      ...(await links("/", signedIn)),
      ...(await links(`/sites/${SITE_ID}`, signedIn)),
    ];
    expect(owner).toContain("/sites/new");
    expect(owner).toContain(`/sites/${SITE_ID}/settings`);

    const offered = [...(await links("/", who)), ...(await links(`/sites/${SITE_ID}`, who))];
    expect(offered).not.toContain("/sites/new");
    expect(offered).not.toContain(`/sites/${SITE_ID}/settings`);
    expect(offered).toContain(`/sites/${SITE_ID}/regions/home.hero`);
  });

  it("shows another person's name wherever they have been, and never their address", async () => {
    site = makeSite({ schema: SCHEMA });
    const who = await editor();
    await post(
      site,
      `/sites/${SITE_ID}/regions/home.hero`,
      { headSha: site.head(), action: "publish", "f[heading]": "By Ed" },
      who,
    );
    await get(site, `/sites/${SITE_ID}/regions/home.hero`, who);
    for (const path of [
      "/",
      `/sites/${SITE_ID}`,
      `/sites/${SITE_ID}/regions/home.hero`,
      `/sites/${SITE_ID}/regions/home.hero/history`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time keeps the failure readable
      const body = await (await get(site, path)).text();
      expect(body, path).not.toContain("ed@example.com");
    }
    const editing = await (await get(site, `/sites/${SITE_ID}/regions/home.hero`)).text();
    expect(editing.replace(/<[^>]+>/g, "")).toMatch(/Also open here:\s+Ed/);
    expect(await (await get(site, `/sites/${SITE_ID}/regions/home.hero/history`)).text()).toContain(
      "Ed",
    );
  });

  it("sends someone already signed in past the sign-in page", async () => {
    site = makeSite({ schema: SCHEMA });
    const response = await get(site, "/sign-in");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });
});

describe("publish later, refused", () => {
  it("answers with the editor and what was typed, for a region and for an entry", async () => {
    site = makeSite({
      schema: SCHEMA,
      files: { "content/blog/first.md": "---\ntitle: First\n---\n\n<p>Body</p>\n" },
    });
    const region = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: site.head(),
      action: "schedule",
      publishAt: "",
      "f[heading]": "Typed before scheduling",
    });
    expect(region.status).toBe(422);
    const document = await page(region);
    expect(document.querySelector(".flash")?.textContent).toMatch(/Nothing was scheduled/);
    expect(document.querySelector<HTMLInputElement>("#f-heading")?.value).toBe(
      "Typed before scheduling",
    );

    const entry = await post(site, `/sites/${SITE_ID}/collections/blog/first`, {
      headSha: site.head(),
      action: "schedule",
      publishAt: "2001-01-01T10:00",
      "f[title]": "Retitled before scheduling",
    });
    expect(entry.status).toBe(422);
    expect((await page(entry)).querySelector<HTMLInputElement>("#f-title")?.value).toBe(
      "Retitled before scheduling",
    );
    expect(site.store.listScheduled(SITE_ID)).toHaveLength(0);
    expect(site.read("content/blog/first.md")).toContain("title: First");
  });

  it("does not treat a refused schedule on a block list as a section edit", async () => {
    site = makeSite({ schema: SCHEMA });
    const response = await post(site, `/sites/${SITE_ID}/regions/home.features`, {
      headSha: site.head(),
      action: "schedule",
      publishAt: "",
      "f[blocks][0][_type]": "feature",
      "f[blocks][0][title]": "Kept",
    });
    expect(response.status).toBe(422);
    const document = await page(response);
    expect(document.querySelector(".flash")?.textContent).toMatch(/Nothing was scheduled/);
    expect(document.querySelector<HTMLInputElement>("#f-blocks-0-title")?.value).toBe("Kept");
  });
});

describe("a site that is a folder inside a larger repository", () => {
  it("commits what it publishes", async () => {
    const outer = temp("greatcms-monorepo-");
    const git = (args: string[]) => execFileSync("git", args, { cwd: outer, stdio: "ignore" });
    const inner = join(outer, "sites", "one");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, "README.md"), "outer\n");
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "initial"]);

    const result = await new LocalRepository(inner).commitFiles({
      message: "Set up GreatCMS",
      files: [{ path: ".cms/schema.yaml", content: "version: 1\n" }],
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const committed = execFileSync("git", ["show", "--name-only", "--format=%s", "HEAD"], {
      cwd: outer,
      encoding: "utf8",
    });
    expect(committed).toContain("Set up GreatCMS");
    expect(committed).toContain("sites/one/.cms/schema.yaml");
  });
});

describe("connecting a folder", () => {
  it("opens the site it already is, rather than connecting it twice", async () => {
    site = makeSite({ schema: SCHEMA });
    const response = await post(site, "/sites", { name: "Again", path: site.root, devUrl: "" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/sites/${SITE_ID}`);
    expect(site.store.listSites()).toHaveLength(1);
  });
});

describe("the inbox", () => {
  it("stays filtered after a submission is marked or deleted", async () => {
    site = makeSite({ schema: SCHEMA });
    for (const message of ["one", "two"]) {
      site.store.addSubmission({
        siteId: SITE_ID,
        form: "contact",
        data: { message },
        spamScore: 0,
        spamReasons: [],
      });
    }
    const document = await page(await get(site, `/inbox?site=${SITE_ID}&spam=1`));
    const forms = [...document.querySelectorAll<HTMLFormElement>('form[action^="/inbox/"]')];
    expect(forms).toHaveLength(4);
    for (const form of forms) {
      const fields = Object.fromEntries(
        [...form.querySelectorAll("input")].map((input) => [input.name, input.value]),
      );
      // oxlint-disable-next-line no-await-in-loop -- each action changes what the next one sees
      const response = await post(site, form.getAttribute("action") as string, fields);
      expect(response.headers.get("location")).toBe(`/inbox?site=${SITE_ID}&spam=1`);
    }

    const elsewhere = await post(site, "/inbox/999/read", { site: "//evil.example", read: "1" });
    expect(elsewhere.headers.get("location")).toBe("/inbox");
  });
});

describe("what the form says", () => {
  it("offers a select's default instead of a None that would not stick", async () => {
    site = makeSite({ schema: SCHEMA });
    const response = await post(site, `/sites/${SITE_ID}/regions/home.features`, {
      headSha: site.head(),
      action: "add",
      addType: "feature",
    });
    const document = await page(response);
    const icon = document.querySelector<HTMLSelectElement>("#f-blocks-0-icon")!;
    expect([...icon.options].map((option) => option.value)).toEqual(["git", "bolt", "lock"]);
    expect(icon.value).toBe("git");
    const tone = document.querySelector<HTMLSelectElement>("#f-blocks-0-tone")!;
    expect([...tone.options].map((option) => option.value)).toEqual(["", "calm", "loud"]);
  });

  it("names what is wrong as the form does, without the schema author's remedy", async () => {
    site = makeSite({ schema: SCHEMA });
    const response = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: site.head(),
      action: "publish",
      "f[heading]": "Hello",
      "f[image][src]": "/media/a.png",
      "f[image][alt]": "",
    });
    expect(response.status).toBe(422);
    const document = await page(response);
    const flash = document.querySelector(".flash")?.textContent ?? "";
    expect(flash).toContain("Image › Alt: Alt text is empty");
    expect(flash).not.toMatch(/fix:|decorative-allowed|image\.alt/);
    expect(document.querySelector('label[for="f-image-alt"]')?.textContent).toContain("(required)");
  });

  it("gives a branch's remedy as a sentence beside the field", async () => {
    site = makeSite({ schema: SCHEMA });
    site.write("notes.txt", "not committed\n");
    const response = await post(site, `/sites/${SITE_ID}/settings`, {
      name: "Example",
      devUrl: "",
      branch: "content",
    });
    expect(response.status).toBe(422);
    const error = (await page(response)).querySelector("#branch-hint-error")?.textContent ?? "";
    expect(error).toMatch(/1 change that is not committed/);
    expect(error).toMatch(/Commit or stash/);
    expect(error).not.toContain("fix:");
  });

  it("puts a token's missing user name beside the user name", async () => {
    const dir = temp("greatcms-access-");
    const app = createApp({
      store: new Store(":memory:"),
      password: PASSWORD,
      secret: SECRET,
      gitAccess: new GitAccess(dir, {}),
    });
    const response = await app.request("/git-access/token", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        host: "git.example.test",
        username: "",
        token: "tok_abcdef123456",
      }),
    });
    expect(response.status).toBe(422);
    const document = await page(response);
    const user = document.querySelector("#token-user")!;
    expect(user.getAttribute("aria-invalid")).toBe("true");
    expect(user.getAttribute("aria-describedby")).toContain("token-error");
    expect(document.querySelector("#token-value")?.hasAttribute("aria-invalid")).toBe(false);
    expect(user.closest(".field")?.querySelector(".error-text")?.textContent).toMatch(/user name/);
    expect(document.querySelector('label[for="token-user"]')?.textContent).not.toMatch(/optional/);
  });
});

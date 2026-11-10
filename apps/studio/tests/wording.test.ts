/** What the studio calls people and times, and what it says after the less common actions. */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import type { Notification } from "../src/submissions.js";
import { type Fixture, makeSite, PASSWORD, SECRET, SITE_ID, signedIn } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }
collections:
  blog:
    path: content/blog
    format: json
    slug: title
    fields:
      title: { type: text, required: true }
`;

let site: Fixture;
const temporary: string[] = [];
afterEach(() => {
  site?.cleanup();
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;
const form = (app: App, path: string, fields: Record<string, string>, headers = signedIn) =>
  app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
const read = async (response: Response | Promise<Response>) =>
  new JSDOM(await (await response).text()).window.document;
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim();
/** The page an action's redirect lands on, with the notice the action left. */
async function landing(app: App, response: Response, headers = signedIn) {
  expect(response.status).toBe(303);
  const flash = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("greatcms_flash="))
    ?.split(";")[0];
  return read(
    app.request(response.headers.get("location") as string, {
      headers: { cookie: `${headers.cookie}; ${flash}` },
    }),
  );
}

async function editorOf(app: App) {
  site.store.addEditor({
    name: "Ed",
    email: "ed@example.com",
    passwordHash: hashPassword("an editor's long password"),
    allSites: true,
  });
  const response = await form(
    app,
    "/sign-in",
    { email: "ed@example.com", password: "an editor's long password" },
    { cookie: "" },
  );
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .find((value) => value.startsWith("greatcms_session="));
  return { cookie: cookie as string };
}

describe("the person who signs in with the studio's password", () => {
  it.each([
    [undefined, "Owner"],
    ["  Alain  ", "Alain"],
  ])("is named %s -> %s in presence, schedules and notifications", async (ownerName, shown) => {
    site = makeSite({ schema: SCHEMA });
    const sent: Notification[] = [];
    const app = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      ownerName,
      notifier: { notify: async (message) => void sent.push(message) },
    });
    const region = `/sites/${SITE_ID}/regions/home.hero`;

    await app.request(region, { headers: signedIn });
    const seen = await read(app.request(region, { headers: await editorOf(app) }));
    expect(text(seen.querySelector("main"))).toContain(`Also open here: ${shown}`);

    await form(app, region, {
      action: "schedule",
      publishAt: "2099-01-01T09:00",
      headSha: site.head(),
      "f[heading]": "Later",
    });
    const overview = await read(app.request(`/sites/${SITE_ID}`, { headers: signedIn }));
    const row = text(overview.querySelector("#scheduled li"));
    expect(row).toMatch(new RegExp(`· ${shown}\\b`));
    expect(row).not.toMatch(/· studio\b/);

    const [job] = site.store.listScheduled(SITE_ID);
    await form(app, `/sites/${SITE_ID}/scheduled/${job!.id}/cancel`, {});
    expect(site.store.getScheduled(job!.id)?.detail).toBe(`cancelled by ${shown}`);

    await form(app, region, { action: "publish", headSha: site.head(), "f[heading]": "Now" });
    expect(sent.at(-1)?.subject).toBe(`Example: ${shown} published home.hero`);
  });
});

describe("times", () => {
  it("are shown in the studio's zone on the history page, as scheduled ones are", async () => {
    site = makeSite({
      schema: SCHEMA,
      files: { "content/cms/home.hero.json": JSON.stringify({ heading: "First" }) },
    });
    const app = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      timeZone: "Asia/Tokyo",
    });
    const history = await read(
      app.request(`/sites/${SITE_ID}/regions/home.hero/history`, { headers: signedIn }),
    );
    const times = [...history.querySelectorAll(".history time")];
    expect(times).toHaveLength(1);
    const stamp = times[0]!;
    const inTokyo = new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Tokyo",
    }).format(new Date(stamp.getAttribute("datetime") as string));
    expect(stamp.textContent).toContain(inTokyo);
    expect(stamp.textContent).toMatch(/GMT\+9$/);
    expect(stamp.textContent).not.toContain("UTC");

    await form(app, `/sites/${SITE_ID}/regions/home.hero`, {
      action: "schedule",
      publishAt: "2099-01-01T09:00",
      headSha: site.head(),
      "f[heading]": "Later",
    });
    const overview = await read(app.request(`/sites/${SITE_ID}`, { headers: signedIn }));
    expect(text(overview.querySelector("#scheduled"))).toContain("times in Asia/Tokyo");
    expect(text(overview.querySelector("#scheduled li"))).toContain("09:00");
  });
});

describe("site settings that were not saved", () => {
  it("keep the Push tick as it was sent, either way", async () => {
    site = makeSite({ schema: SCHEMA });
    const settings = `/sites/${SITE_ID}/settings`;
    const ticked = async (response: Response | Promise<Response>) =>
      (await read(response)).querySelector<HTMLInputElement>("#pushAfterPublish")?.checked;

    const refused = await form(site.app, settings, {
      name: "Example",
      devUrl: "javascript:alert(1)",
      pushAfterPublish: "on",
    });
    expect(refused.status).toBe(422);
    expect(await ticked(refused)).toBe(true);
    expect(site.store.getSite(SITE_ID)?.pushAfterPublish).toBe(false);

    site.store.updateSite(SITE_ID, { name: "Example", devUrl: "", pushAfterPublish: true });
    expect(await ticked(form(site.app, settings, { name: "" }))).toBe(false);
    expect(await ticked(site.app.request(settings, { headers: signedIn }))).toBe(true);
  });
});

describe("a folder with no schema", () => {
  it("is set up without an error from the folder list, and with one when connected directly", async () => {
    site = makeSite({ schema: SCHEMA });
    const root = mkdtempSync(join(tmpdir(), "greatcms-wording-"));
    temporary.push(root);
    mkdirSync(join(root, "bare"));
    const app = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      sitesRoot: root,
    });

    const list = await read(app.request("/sites/new", { headers: signedIn }));
    const link = [...list.querySelectorAll("a")].find((a) => text(a) === "Set up bare");
    const listed = await app.request(link?.getAttribute("href") as string, { headers: signedIn });
    expect(listed.status).toBe(200);
    const calm = await read(listed);
    expect(calm.querySelector(".flash")).toBeNull();
    expect(text(calm.querySelector(".lede"))).toContain("has no .cms/schema.yaml yet");

    const direct = await form(app, "/sites", { path: join(root, "bare") });
    expect(direct.status).toBe(422);
    expect(text((await read(direct)).querySelector(".flash.error"))).toContain(
      "has no .cms/schema.yaml",
    );
  });
});

describe("a new entry", () => {
  it("is opened at its own address once published, with the result said there", async () => {
    site = makeSite({ schema: SCHEMA });
    const created = await form(site.app, `/sites/${SITE_ID}/collections/blog/new`, {
      "f[title]": "Hello there",
    });
    expect(created.headers.get("location")).toBe(`/sites/${SITE_ID}/collections/blog/hello-there`);
    const opened = await landing(site.app, created);
    expect(text(opened.querySelector(".flash.success"))).toMatch(/^Published as [0-9a-f]{7}\./);
    expect(opened.querySelector<HTMLFormElement>("#editor-form")?.getAttribute("action")).toBe(
      `/sites/${SITE_ID}/collections/blog/hello-there`,
    );
    expect(site.exists("content/blog/hello-there.json")).toBe(true);
  });

  it("stays on the form when it is not valid, with what was typed", async () => {
    site = makeSite({ schema: SCHEMA });
    const refused = await form(site.app, `/sites/${SITE_ID}/collections/blog/new`, {
      "f[title]": "",
    });
    expect(refused.status).toBe(422);
    expect(refused.headers.get("location")).toBeNull();
  });
});

describe("restoring a version from history", () => {
  it("says which version is in the form, and that nothing is published yet", async () => {
    site = makeSite({
      schema: SCHEMA,
      files: { "content/cms/home.hero.json": JSON.stringify({ heading: "First" }) },
    });
    const first = site.head();
    site.commit("content/cms/home.hero.json", JSON.stringify({ heading: "Second" }));
    const restored = await form(
      site.app,
      `/sites/${SITE_ID}/regions/home.hero/history/${first}/restore`,
      {},
    );
    const editor = await landing(site.app, restored);
    expect(text(editor.querySelector(".flash.success"))).toBe(
      `Version ${first.slice(0, 7)} is in the form as unsaved edits. Publish to bring it back, or discard them to keep what is published.`,
    );
    const notice = text(editor.querySelector(".draft-notice"));
    expect(notice).toContain("This form holds unsaved edits.");
    expect(notice).not.toContain("what you were editing last time");
    expect(JSON.parse(site.read("content/cms/home.hero.json")).heading).toBe("Second");
  });
});

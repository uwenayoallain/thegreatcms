/** An action that answers with a redirect says what it did on the page the redirect lands on, once. */

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { flashCookie, hashPassword, readFlash, sessionKey } from "../src/auth.js";
import { type Fixture, get, makeSite, PASSWORD, post, SECRET, SITE_ID, signedIn } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
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
afterEach(() => site?.cleanup());

const KEY = sessionKey(SECRET, PASSWORD);
const cookieOf = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .find((value) => value.startsWith(`${name}=`));

/** Follows an action's redirect as a browser would, carrying the notice it was handed. */
async function follow(response: Response, headers = signedIn) {
  expect(response.status).toBe(303);
  const flash = cookieOf(response, "greatcms_flash");
  expect(flash, "the redirect carries a notice").toBeTruthy();
  const landed = await get(site, response.headers.get("location") as string, {
    cookie: `${headers.cookie}; ${flash}`,
  });
  const document = new JSDOM(await landed.text()).window.document;
  return { landed, flash: flash as string, notice: document.querySelector("main > .flash") };
}

describe("a notice after an action", () => {
  it("is shown once on the page the redirect lands on, announced, and then cleared", async () => {
    site = makeSite({ schema: SCHEMA });
    const saved = await post(site, `/sites/${SITE_ID}/settings`, { name: "Renamed" });
    expect(saved.headers.getSetCookie().join("\n")).toMatch(
      /greatcms_flash=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60/,
    );
    const { landed, notice } = await follow(saved);
    expect(notice?.textContent).toContain("Settings saved.");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(landed.headers.getSetCookie().join("\n")).toMatch(/greatcms_flash=; .*Max-Age=0/);
    // No script was added to say it.
    expect(notice?.ownerDocument.querySelector("script")).toBeNull();

    const again = await (await get(site, `/sites/${SITE_ID}`)).text();
    expect(again).not.toContain("Settings saved.");
  });

  it("follows each action that used to answer with silence", async () => {
    site = makeSite({
      schema: SCHEMA,
      files: { "content/blog/first.json": JSON.stringify({ title: "First post" }) },
    });
    const said = async (response: Response | Promise<Response>) =>
      (await follow(await response)).notice?.textContent?.replace(/\s+/g, " ").trim();

    expect(await said(post(site, `/sites/${SITE_ID}/collections/blog/first/delete`, {}))).toContain(
      "Deleted “First post”.",
    );

    site.store.addSubmission({
      siteId: SITE_ID,
      form: "contact",
      data: { message: "Hello" },
      spamScore: 0,
      spamReasons: [],
    });
    const [submission] = site.store.listSubmissions({});
    expect(await said(post(site, `/inbox/${submission!.id}/read`, { read: "1" }))).toBe(
      "Marked as read.",
    );
    expect(await said(post(site, `/inbox/${submission!.id}/read`, { read: "0" }))).toBe(
      "Marked as unread.",
    );
    expect(await said(post(site, `/inbox/${submission!.id}/delete`, {}))).toBe(
      "The submission is deleted.",
    );

    site.store.addEditor({
      name: "Ed",
      email: "ed@example.com",
      passwordHash: hashPassword("an editor's long password"),
      allSites: true,
    });
    const [editor] = site.store.listEditors();
    expect(await said(post(site, `/editors/${editor!.id}/delete`, {}))).toBe(
      "Ed can no longer sign in.",
    );

    const scheduled = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      action: "schedule",
      publishAt: "2099-01-01T09:00",
      headSha: site.head(),
      "f[heading]": "Later",
    });
    expect(await said(scheduled)).toContain("Scheduled.");
    const [job] = site.store.listScheduled(SITE_ID);
    expect(await said(post(site, `/sites/${SITE_ID}/scheduled/${job!.id}/cancel`, {}))).toBe(
      "The scheduled publish of home.hero is cancelled.",
    );

    expect(await said(post(site, `/sites/${SITE_ID}/delete`, {}))).toContain(
      "Example is disconnected.",
    );
  });

  it("says a push happened", async () => {
    site = makeSite({ schema: SCHEMA });
    site.git(["init", "-q", "--bare", ".git/remote.git"]);
    site.git(["remote", "add", "origin", `${site.root}/.git/remote.git`]);
    site.git(["push", "-q", "-u", "origin", "main"]);
    site.commit("content/cms/home.hero.json", JSON.stringify({ heading: "Ahead" }));
    const { notice } = await follow(await post(site, `/sites/${SITE_ID}/push`, {}));
    expect(notice?.textContent).toContain("Pushed to origin/main.");
  });

  it("escapes a name that is markup, and never trusts a notice it did not sign", async () => {
    site = makeSite({ schema: SCHEMA });
    site.store.updateSite(SITE_ID, {
      name: "<img src=x onerror=alert(1)>",
      devUrl: "",
      pushAfterPublish: false,
      deployRoot: "",
    });
    const { landed, notice } = await follow(await post(site, `/sites/${SITE_ID}/delete`, {}));
    expect(notice?.querySelector("img")).toBeNull();
    expect(notice?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(landed.status).toBe(200);

    const text = Buffer.from("Forged <b>notice</b>").toString("base64url");
    const forged = `greatcms_flash=success.${text}.${Date.now() + 30_000}.nope`;
    const shown = await get(site, "/", { cookie: `${signedIn.cookie}; ${forged}` });
    expect(await shown.text()).not.toContain("Forged");
    expect(shown.headers.getSetCookie().join("\n")).toMatch(/greatcms_flash=; .*Max-Age=0/);
  });

  it("is for the person whose action it was, and for a minute", () => {
    const cookie = flashCookie(KEY, "studio", { kind: "success", message: "Done." }, false, 1000);
    const header = cookie.split(";")[0];
    expect(readFlash(header, KEY, "studio", 2000)).toEqual({ kind: "success", message: "Done." });
    expect(readFlash(header, KEY, "editor:1", 2000)).toBeNull();
    expect(readFlash(header, KEY, "studio", 62_000)).toBeNull();
    expect(readFlash(header, sessionKey(SECRET, "another password"), "studio", 2000)).toBeNull();
  });

  it("waits through a redirect that draws nothing", async () => {
    site = makeSite({ schema: SCHEMA });
    const flash = flashCookie(KEY, "studio", { kind: "success", message: "Kept." }).split(";")[0];
    const moved = await get(site, "/sites", { cookie: `${signedIn.cookie}; ${flash}` });
    expect(moved.status).toBe(301);
    expect(moved.headers.getSetCookie().join("\n")).not.toContain("greatcms_flash");
  });
});

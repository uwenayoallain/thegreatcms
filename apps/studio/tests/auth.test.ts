/** Attacks on sign-in, sessions and the publish path, each one a regression for a fixed hole. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createShareToken, hashPassword, sessionKey } from "../src/auth.js";
import { type Fixture, makeSite, PASSWORD, SECRET, SITE_ID, signedIn } from "./site.js";

const FIXTURES = join(import.meta.dirname, "../../../packages/conformance/fixtures");
const fixture = (path: string) => readFileSync(join(FIXTURES, path), "utf8");
const key = sessionKey(SECRET, PASSWORD);
const form = { "content-type": "application/x-www-form-urlencoded" };

let site: Fixture;
afterEach(() => site?.cleanup());

function open(devUrl = "") {
  site = makeSite({
    schema: fixture(".cms/schema.yaml"),
    config: fixture(".cms/config.yaml"),
    files: { "content/cms/home.hero.json": fixture("content/cms/home.hero.json") },
    devUrl,
  });
  return site;
}

const cookiesOf = (response: Response) =>
  response.headers.getSetCookie().map((cookie) => cookie.split(";")[0] as string);

async function signInAs(app: ReturnType<typeof createApp>, email: string, password: string) {
  const response = await app.request("/sign-in", {
    method: "POST",
    headers: form,
    body: new URLSearchParams({ email, password }),
  });
  expect(response.status).toBe(303);
  return response;
}

async function editorCookie(password = "an editor's long password") {
  site.store.addEditor({
    name: "Ed",
    email: "ed@example.com",
    passwordHash: hashPassword(password),
    allSites: true,
  });
  const response = await signInAs(site.app, "ed@example.com", password);
  return cookiesOf(response).find((cookie) => cookie.startsWith("greatcms_session="))!;
}

const heroForm = (headSha: string) => ({
  headSha,
  "f[heading]": "Edited",
  "f[subtitle]": "x",
  "f[image][src]": "/media/hero.webp",
  "f[image][alt]": "A person",
  "f[cta][href]": "/go",
  "f[cta][label]": "Go",
});

const victimBeside = (name: string) => {
  const path = join(site.root, "..", `${name}-${process.pid}-${Date.now()}.txt`);
  writeFileSync(path, "precious");
  return path;
};

describe("sessions", () => {
  it("never takes a share link for a session", async () => {
    open("http://preview.example.com");
    const [id, expiry, signature] = createShareToken(key, SITE_ID).split(".");
    const forged = [`share ${id}.${expiry}.${signature}`, `${id}.${expiry}.${signature}`];
    const responses = await Promise.all(
      forged.map((value) =>
        site.app.request("/editors", {
          headers: { cookie: `greatcms_session=${encodeURIComponent(value)}` },
        }),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/sign-in?next=%2Feditors");
    }
  });

  it("treats a cookie that is not valid percent-encoding as signed out", async () => {
    open();
    const response = await site.app.request("/", {
      headers: { cookie: "greatcms_session=%E0%A4%A" },
    });
    expect(response.status).toBe(303);
    const check = await site.app.request("/auth/check", {
      headers: { cookie: "greatcms_share=%E0%A4%A; greatcms_preview=%zz" },
    });
    expect(check.status).toBe(401);
  });

  it("ends an editor's sessions when their password changes", async () => {
    open();
    const cookie = await editorCookie();
    expect((await site.app.request(`/sites/${SITE_ID}`, { headers: { cookie } })).status).toBe(200);

    const editor = site.store.findEditor("ed@example.com")!;
    site.store.setEditorPassword(editor.id, hashPassword("a different long password"));
    const after = await site.app.request(`/sites/${SITE_ID}`, { headers: { cookie } });
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toBe("/sign-in");
  });

  it("keeps the studio's session on the studio's host, and gives the preview its own cookie", async () => {
    open("https://preview.example.com");
    const app = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      publicUrl: "https://studio.example.com",
      cookieDomain: "example.com",
    });
    const response = await app.request("/sign-in", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ password: PASSWORD }),
    });
    const [session, preview] = response.headers.getSetCookie();
    expect(session).toMatch(/^greatcms_session=/);
    expect(session).not.toContain("Domain=");
    expect(preview).toMatch(/^greatcms_preview=.*; Domain=example\.com/);

    const check = (cookie: string) =>
      app.request("/auth/check", {
        headers: { cookie, "x-forwarded-host": "preview.example.com", "x-forwarded-uri": "/" },
      });
    const previewCookie = preview!.split(";")[0]!;
    expect((await check(previewCookie)).status).toBe(204);
    // The preview's cookie opens the preview, and the studio not at all.
    const studio = await app.request("/", { headers: { cookie: previewCookie } });
    expect(studio.status).toBe(303);

    // Signed in at the studio but without the preview's cookie: renewed, not asked again.
    const back = await app.request(
      `/sign-in?next=${encodeURIComponent("https://preview.example.com/about")}`,
      { headers: { cookie: session!.split(";")[0]! } },
    );
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("https://preview.example.com/about");
    expect(back.headers.getSetCookie().join("\n")).toContain("greatcms_preview=");
  });

  it("closes the preview to an editor who has been removed", async () => {
    open("https://preview.example.com");
    site.store.addEditor({
      name: "Ed",
      email: "ed@example.com",
      passwordHash: hashPassword("an editor's long password"),
      allSites: true,
    });
    const app = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      publicUrl: "https://studio.example.com",
      cookieDomain: "example.com",
    });
    const preview = cookiesOf(
      await signInAs(app, "ed@example.com", "an editor's long password"),
    ).find((cookie) => cookie.startsWith("greatcms_preview="))!;
    const check = () =>
      app.request("/auth/check", {
        headers: {
          cookie: preview,
          "x-forwarded-host": "preview.example.com",
          "x-forwarded-uri": "/",
        },
      });
    expect((await check()).status).toBe(204);
    site.store.removeEditor(site.store.findEditor("ed@example.com")!.id);
    expect((await check()).status).not.toBe(204);
  });
});

describe("what only the owner can do", () => {
  it("refuses an editor however the path is spelled", async () => {
    open();
    const cookie = await editorCookie();
    const paths = ["/editors", "/%65ditors", "/%65ditors/", "/sites/new", "/%73ites/new"];
    const responses = await Promise.all(
      paths.map((path) => site.app.request(path, { headers: { cookie } })),
    );
    for (const [index, response] of responses.entries()) {
      expect(response.status, paths[index]).not.toBe(200);
    }
    const settings = await site.app.request(`/sites/${SITE_ID}/%73ettings`, {
      method: "POST",
      headers: { cookie, ...form },
      body: new URLSearchParams({ name: "Example", devUrl: "http://evil.example" }),
    });
    expect(settings.status).toBe(403);
    expect(site.store.getSite(SITE_ID)?.devUrl).toBe("");
    const remove = await site.app.request(`/sites/${SITE_ID}/%64elete`, {
      method: "POST",
      headers: { cookie },
    });
    expect(remove.status).toBe(403);
    expect(site.store.getSite(SITE_ID)).toBeTruthy();
  });

  it("still lets an editor edit content", async () => {
    open();
    const cookie = await editorCookie();
    const response = await site.app.request(`/sites/${SITE_ID}/regions/home.hero`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
  });
});

describe("what reaches git", () => {
  it("refuses a commit id that git would read as an option", async () => {
    open();
    const victim = victimBeside("victim");
    const body = new URLSearchParams({ ...heroForm(`--output=${victim}`), action: "publish" });
    const response = await site.app.request(`/sites/${SITE_ID}/regions/home.hero`, {
      method: "POST",
      headers: { ...signedIn, ...form },
      body,
    });
    expect(response.status).toBe(409);
    expect(readFileSync(victim, "utf8")).toBe("precious");
  });

  it("reads a draft's recorded base as data, not as an argument", async () => {
    open();
    const victim = victimBeside("victim-base");
    site.write(".cms/draft/content/cms/home.hero.json", fixture("content/cms/home.hero.json"));
    site.write(".cms/draft/.base/content/cms/home.hero.json", `--output=${victim}\n`);
    const response = await site.app.request(`/sites/${SITE_ID}/regions/home.hero`, {
      headers: signedIn,
    });
    expect(response.status).toBe(200);
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(await response.text()).not.toContain("--output");
  });
});

describe("links and schedules", () => {
  it("keeps a share link on the site's own preview host", async () => {
    open("https://preview.example.com");
    const page = await (
      await site.app.request(`/sites/${SITE_ID}/share`, {
        method: "POST",
        headers: { ...signedIn, ...form },
        body: new URLSearchParams({ path: "//evil.example/steal" }),
      })
    ).text();
    expect(page).toContain("https://preview.example.com/?greatcms-share=");
    expect(page).not.toContain("evil.example");
  });

  it("schedules only content that could exist", async () => {
    open();
    const response = await site.app.request(`/sites/${SITE_ID}/regions/..%2F..%2Feditors`, {
      method: "POST",
      headers: { ...signedIn, ...form },
      body: new URLSearchParams({ action: "schedule", publishAt: "2099-01-01T09:00" }),
    });
    expect(response.status).toBe(404);
    expect(site.store.dueScheduled(Date.parse("2100-01-01"))).toHaveLength(0);
  });

  it("does not let a path skip sign-in by naming an object's own property", async () => {
    open();
    const paths = ["/constructor", "/toString", "/__proto__"];
    const responses = await Promise.all(paths.map((path) => site.app.request(path)));
    for (const [index, response] of responses.entries()) {
      expect(response.status, paths[index]).toBe(303);
    }
  });

  it("still publishes an editor's scheduled change after they change their password", async () => {
    open();
    const cookie = await editorCookie();
    const scheduled = await site.app.request(`/sites/${SITE_ID}/regions/home.hero`, {
      method: "POST",
      headers: { cookie, ...form },
      body: new URLSearchParams({
        ...heroForm(site.head()),
        action: "schedule",
        publishAt: "2099-01-01T09:00",
      }),
    });
    expect(scheduled.status).toBe(303);
    const editor = site.store.findEditor("ed@example.com")!;
    site.store.setEditorPassword(editor.id, hashPassword("a different long password"));

    const app = site.app as unknown as { runDueSchedules(now?: number): Promise<void> };
    await app.runDueSchedules(Date.parse("2100-01-01"));
    const [job] = site.store.listScheduled(SITE_ID);
    expect(job?.status, job?.detail ?? "").toBe("published");
    expect(site.read("content/cms/home.hero.json")).toContain("Edited");
  });
});

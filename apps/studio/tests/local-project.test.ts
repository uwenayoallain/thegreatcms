/** The local studio is for one project: nothing about other sites, other people, or hosting is offered or reachable. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type Fixture, makeSite, PASSWORD, SECRET, signedIn, SITE_ID } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Hero
    fields:
      heading: { type: text, default: Hello }
`;

const MULTI_SITE = [
  "/sites/new",
  "/sites/setup",
  "/sites/clone",
  "/sites/clone/dismiss",
  "/git-access",
  "/git-access/github",
  "/git-access/token",
  "/editors",
  "/editors/1/delete",
  `/sites/${SITE_ID}/delete`,
];

let site: Fixture;
let local: ReturnType<typeof createApp>;

const form = { ...signedIn, "content-type": "application/x-www-form-urlencoded" };

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
  local = createApp({ store: site.store, password: PASSWORD, secret: SECRET, local: true });
});

afterEach(() => {
  site.store.close();
  site.cleanup();
});

describe("routes the local studio does not have", () => {
  it.each(MULTI_SITE)("answers 404 for a page load of %s", async (path) => {
    expect((await local.request(path, { headers: signedIn })).status).toBe(404);
  });

  it.each([...MULTI_SITE, "/sites"])("answers 404 for a form post to %s", async (path) => {
    const response = await local.request(path, {
      method: "POST",
      headers: form,
      body: "name=Other&path=/tmp/other&host=example.com&token=t&email=a@b.co",
    });
    expect(response.status).toBe(404);
  });

  it("cannot disconnect its one site, connect another, or add an editor", async () => {
    await local.request(`/sites/${SITE_ID}/delete`, { method: "POST", headers: form });
    await local.request("/sites", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ name: "Other", path: site.root }),
    });
    await local.request("/editors", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({
        name: "Ann",
        email: "ann@example.com",
        password: "a long enough password",
      }),
    });
    expect(site.store.listSites().map((entry) => entry.id)).toEqual([SITE_ID]);
    expect(site.store.listEditors()).toEqual([]);
  });

  it("still has them on a studio that is not local", async () => {
    for (const path of ["/sites/new", "/editors"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      expect((await site.app.request(path, { headers: signedIn })).status, path).toBe(200);
    }
  });

  it("asks a signed-out visitor to sign in before saying what exists", async () => {
    const response = await local.request("/editors");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^\/sign-in/);
  });
});

describe("what the local studio shows", () => {
  it("opens on the site, not on a list of sites", async () => {
    const home = await local.request("/", { headers: signedIn });
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe(`/sites/${SITE_ID}`);
    const list = await local.request("/sites", { headers: signedIn });
    expect(list.headers.get("location")).toBe("/");
  });

  it("offers nothing that leads to another site or another person", async () => {
    for (const path of [
      `/sites/${SITE_ID}`,
      `/sites/${SITE_ID}/regions/home.hero`,
      `/sites/${SITE_ID}/settings`,
      "/inbox",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order
      const response = await local.request(path, { headers: signedIn });
      expect(response.status, path).toBe(200);
      // oxlint-disable-next-line no-await-in-loop -- the body of the response just read
      const html = await response.text();
      for (const gone of [
        "Connect a site",
        'href="/sites/new"',
        'href="/editors"',
        'href="/git-access"',
        "Disconnect",
        "/delete",
        "Copy from Git",
        "> Sites<",
      ]) {
        expect(html, `${path} has ${gone}`).not.toContain(gone);
      }
    }
  });

  it("shows all of that on a studio that is not local", async () => {
    const settings = await (
      await site.app.request(`/sites/${SITE_ID}/settings`, { headers: signedIn })
    ).text();
    expect(settings).toContain("Disconnect");
    expect(settings).toContain('href="/editors"');
    expect(settings).toContain("Sites</a");
  });

  it("keeps the settings that make sense for one project: name, dev URL, branch", async () => {
    const page = await (
      await local.request(`/sites/${SITE_ID}/settings`, { headers: signedIn })
    ).text();
    expect(page).toContain('name="name"');
    expect(page).toContain('name="devUrl"');
    expect(page).toContain('name="branch"');

    const saved = await local.request(`/sites/${SITE_ID}/settings`, {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ name: "Renamed", devUrl: "http://localhost:4400" }),
    });
    expect(saved.status).toBeLessThan(400);
    expect(site.store.getSite(SITE_ID)?.name).toBe("Renamed");
    expect(site.store.getSite(SITE_ID)?.devUrl).toBe("http://localhost:4400");
  });
});

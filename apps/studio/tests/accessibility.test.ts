/** What a screen reader is told on the screens an earlier pass found silent or ambiguous. */

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth.js";
import { type Fixture, get, makeSite, SITE_ID } from "./site.js";

const SCHEMA = `version: 1
blocks:
  feature:
    label: Feature
    fields:
      heading: { type: text, required: true }
regions:
  home.sections:
    type: blocks
    allow: [feature]
    default:
      - { _type: feature, heading: One }
      - { _type: feature, heading: Two }
      - { _type: feature, heading: Three }
`;

let site: Fixture;
afterEach(() => site?.cleanup());

const page = async (response: Response) => new JSDOM(await response.text()).window.document;

describe("a page that refuses or finds nothing", () => {
  it("has one h1 saying which, for an editor sent away from the owner's pages", async () => {
    site = makeSite({ schema: SCHEMA });
    site.store.addEditor({
      name: "Ed",
      email: "ed@example.com",
      passwordHash: hashPassword("an editor's long password"),
      allSites: true,
    });
    const signIn = await site.app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ed@example.com", password: "an editor's long password" }),
    });
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] as string)
      .find((value) => value.startsWith("greatcms_session=")) as string;

    const refused = await get(site, "/editors", { cookie });
    expect(refused.status).toBe(403);
    const document = await page(refused);
    const headings = [...document.querySelectorAll("h1")];
    expect(headings.map((heading) => heading.textContent)).toEqual(["Only the owner can do that"]);
    expect(document.querySelector(".flash")?.getAttribute("role")).toBe("alert");
  });

  it("has an h1 when the address leads nowhere", async () => {
    site = makeSite({ schema: SCHEMA });
    const missing = await get(site, "/sites/nowhere");
    expect(missing.status).toBe(404);
    expect((await page(missing)).querySelector("h1")?.textContent).toBe("Not found");
  });
});

describe("the buttons that move a section", () => {
  it("each say which section they move, so three of one type are told apart", async () => {
    site = makeSite({ schema: SCHEMA });
    const document = await page(await get(site, `/sites/${SITE_ID}/regions/home.sections`));
    const names = [...document.querySelectorAll('.block > .tools button[name="action"]')]
      .filter((button) => /^(up|down):/.test(button.getAttribute("value") ?? ""))
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      "Move section 1 (Feature) up",
      "Move section 1 (Feature) down",
      "Move section 2 (Feature) up",
      "Move section 2 (Feature) down",
      "Move section 3 (Feature) up",
      "Move section 3 (Feature) down",
    ]);
    expect(new Set(names).size).toBe(names.length);
    const groups = [...document.querySelectorAll(".block > .tools")].map((group) =>
      group.getAttribute("aria-label"),
    );
    expect(groups).toEqual([
      "Reorder or remove section 1 (Feature)",
      "Reorder or remove section 2 (Feature)",
      "Reorder or remove section 3 (Feature)",
    ]);
  });
});

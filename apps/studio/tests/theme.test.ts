/** The theme switch: a form post that sets a cookie, read back on every screen. */

import { afterEach, describe, expect, it } from "vitest";
import { type Fixture, get, makeSite, post, signedIn } from "./site.js";

const SCHEMA = "version: 1\nregions:\n  home.hero:\n    fields:\n      heading: { type: text }\n";

let site: Fixture;
afterEach(() => site.cleanup());

const choose = (theme: string, headers: Record<string, string> = signedIn) =>
  post(site, "/theme", { theme }, { ...headers, referer: "http://localhost/inbox" });

describe("the theme switch", () => {
  it("keeps the choice in a cookie and returns to the screen it was on", async () => {
    site = makeSite({ schema: SCHEMA });
    const response = await choose("dark");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/inbox");
    expect(response.headers.get("set-cookie")).toMatch(/^greatcms_theme=dark;/);
  });

  it("draws every screen in the chosen theme, the sign-in page included", async () => {
    site = makeSite({ schema: SCHEMA });
    const cookie = `${signedIn.cookie}; greatcms_theme=dark`;

    expect(await (await get(site, "/", { cookie })).text()).toContain('data-theme="dark"');
    expect(
      await (await get(site, "/sign-in", { cookie: "greatcms_theme=light" })).text(),
    ).toContain('data-theme="light"');
  });

  it("follows the system when nothing, or nonsense, was chosen", async () => {
    site = makeSite({ schema: SCHEMA });
    const cookie = `${signedIn.cookie}; greatcms_theme=%22%3E%3Cscript%3E`;

    expect(await (await get(site, "/", { cookie })).text()).toContain('data-theme="system"');
    expect((await choose("purple")).headers.get("set-cookie")).toMatch(/^greatcms_theme=system;/);
  });

  it("is refused from another site, so it cannot be used to send anyone anywhere", async () => {
    site = makeSite({ schema: SCHEMA });
    const response = await post(
      site,
      "/theme",
      { theme: "dark" },
      {
        ...signedIn,
        referer: "https://evil.example/phish",
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});

/** A preview runs a site's code on a sibling host, which can set cookies for the parent domain: none of them reaches into the studio. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  createPreviewCookie,
  createSessionCookie,
  createShareToken,
  flashCookie,
  readFlash,
  readGithubTrip,
  readSession,
  sessionKey,
  startGithubTrip,
} from "../src/auth.js";
import { panesOf } from "../src/views/chrome.js";
import { themeOf } from "../src/views/theme.js";
import { makeSite, PASSWORD, SECRET, SITE_ID, type Fixture } from "./site.js";

const KEY = sessionKey(SECRET, PASSWORD);
const STUDIO = "https://studio.example.com";
const value = (cookie: string) => cookie.split(";")[0] as string;
const valueOnly = (cookie: string) => value(cookie).slice(value(cookie).indexOf("=") + 1);

let site: Fixture;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  site = makeSite({
    schema: "version: 1\nregions:\n  home.hero:\n    fields:\n      heading: { type: text }\n",
    devUrl: "https://site-preview.example.com",
  });
  app = createApp({
    store: site.store,
    password: PASSWORD,
    secret: SECRET,
    cookieDomain: "example.com",
    publicUrl: STUDIO,
  });
});

afterEach(() => site.cleanup());

const visit = (path: string, cookie: string, base = STUDIO) =>
  app.request(`${base}${path}`, { headers: { cookie } });

const signIn = async (base = STUDIO) => {
  const response = await app.request(`${base}/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ password: PASSWORD }),
  });
  return response.headers.getSetCookie();
};

describe("the studio's session cookie", () => {
  it("is named so a browser takes it from the studio's host alone, over HTTPS", async () => {
    const cookies = await signIn();
    const session = cookies.find((cookie) => cookie.startsWith("__Host-greatcms_session="));

    expect(session).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect(session).not.toContain("Domain=");
    // The name from before the prefix is dropped, so it does not linger in the browser.
    expect(cookies).toContain(
      "greatcms_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    );
    expect((await visit("/", value(session as string))).status).toBe(200);
  });

  it("keeps its plain name on http, where localhost and the local studio run", async () => {
    const cookies = await signIn("http://localhost:8787");
    const session = cookies.find((cookie) => cookie.startsWith("greatcms_session="));

    expect(session).toBeDefined();
    expect(session).not.toContain("Secure");
    expect(cookies.some((cookie) => cookie.startsWith("__Host-"))).toBe(false);
    expect((await visit("/", value(session as string), "http://localhost:8787")).status).toBe(200);
  });

  it("is not read under the plain name over HTTPS, the one a preview could plant", async () => {
    // A real session, as an editor or a site's developer could hold, tossed at the parent domain.
    const planted = value(createSessionCookie(KEY));
    expect(planted.startsWith("greatcms_session=")).toBe(true);

    const response = await visit("/", planted);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("does not let a planted plain cookie stand in front of the real one", async () => {
    const real = value(createSessionCookie(KEY, { secure: true }));
    const planted = "greatcms_session=nonsense";
    for (const cookie of [`${planted}; ${real}`, `${real}; ${planted}`]) {
      // oxlint-disable-next-line no-await-in-loop -- two orders a browser could send
      expect((await visit("/", cookie)).status).toBe(200);
    }
  });

  it("asks an existing session from before the prefix for one sign-in, not more", async () => {
    const old = value(createSessionCookie(KEY));
    expect((await visit("/", old)).headers.get("location")).toBe("/sign-in");

    const session = (await signIn()).find((cookie) => cookie.startsWith("__Host-"));
    expect((await visit("/", value(session as string))).status).toBe(200);
  });
});

describe("the preview's cookie, set for the parent domain", () => {
  const preview = () =>
    valueOnly(createPreviewCookie(KEY, { secure: true, domain: "example.com" }));

  it("opens the preview", async () => {
    const response = await app.request(`${STUDIO}/auth/check`, {
      headers: {
        cookie: `greatcms_preview=${preview()}`,
        "x-forwarded-host": "site-preview.example.com",
      },
    });
    expect(response.status).toBe(204);
  });

  it("never signs anyone in to the studio, under any name or shape", async () => {
    const token = preview();
    const share = createShareToken(KEY, SITE_ID);
    const shapes = [
      `greatcms_preview=${token}`,
      `greatcms_session=${token}`,
      `__Host-greatcms_session=${token}`,
      `__Host-greatcms_session=${decodeURIComponent(token)}`,
      `__Secure-greatcms_session=${token}`,
      `greatcms_session=${token}; __Host-greatcms_session=${token}; greatcms_preview=${token}`,
      `__Host-greatcms_session=${encodeURIComponent(share)}`,
      `greatcms_share=${encodeURIComponent(share)}; __Host-greatcms_session=${encodeURIComponent(share)}`,
      `__Host-greatcms_session=${token.replace(/\.[^.]+$/, "")}`,
      `__Host-greatcms_session=studio.-.99999999999999.${token.split(".").at(-1)}`,
      "__Host-greatcms_session=%E0%A4%A",
      "__Host-greatcms_session=",
    ];
    for (const cookie of shapes) {
      for (const base of [STUDIO, "http://localhost:8787"]) {
        // oxlint-disable-next-line no-await-in-loop -- each shape is its own request
        const page = await visit("/", cookie, base);
        expect(page.status, cookie).toBe(303);
        // oxlint-disable-next-line no-await-in-loop -- as above
        const write = await app.request(`${base}/sites/${SITE_ID}/settings`, {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ name: "Taken", devUrl: "" }),
        });
        expect(write.status, cookie).toBe(401);
      }
    }
    expect(site.store.getSite(SITE_ID)?.name).toBe("Example");
    expect(readSession(`__Host-greatcms_session=${token}`, KEY, true)).toBeNull();
  });
});

describe("the notice cookie", () => {
  const session = value(createSessionCookie(KEY, { secure: true }));

  it("is prefixed over HTTPS, and a planted plain one is neither shown nor answered", async () => {
    const real = flashCookie(KEY, "studio", { kind: "success", message: "Saved." }, true);
    expect(real.startsWith("__Host-greatcms_flash=")).toBe(true);

    const forged = value(flashCookie(KEY, "studio", { kind: "error", message: "Call 555" }));
    const response = await visit("/", `${session}; ${forged}`);

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("Call 555");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("shows nothing for a notice that is not signed for this person", async () => {
    const markup = Buffer.from("<script>alert(1)</script>").toString("base64url");
    for (const planted of [
      `__Host-greatcms_flash=success.${markup}.99999999999999.forged`,
      `__Host-greatcms_flash=${value(flashCookie(KEY, "editor:7", { kind: "success", message: "Theirs" }, true)).split("=")[1]}`,
      "__Host-greatcms_flash=....",
      "__Host-greatcms_flash=",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each shape is its own request
      const response = await visit("/", `${session}; ${planted}`);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const page = await response.text();
      expect(response.status, planted).toBe(200);
      expect(page).not.toContain("<script>alert(1)</script>");
      expect(page).not.toContain("Theirs");
    }
    expect(readFlash("greatcms_flash=success.eA.99999999999999.x", KEY, "studio")).toBeNull();
  });

  it("escapes a real notice's text", async () => {
    const real = value(
      flashCookie(KEY, "studio", { kind: "success", message: "<b>Saved</b> & done" }, true),
    );
    const page = await (await visit("/", `${session}; ${real}`)).text();
    expect(page).toContain("&lt;b&gt;Saved&lt;/b&gt; &amp; done");
  });
});

describe("the GitHub sign-in cookie", () => {
  it("is prefixed over HTTPS, so a trip begun elsewhere cannot be planted", () => {
    const { cookie, trip } = startGithubTrip(KEY, "/sites", true);
    expect(cookie).toMatch(
      /^__Host-greatcms_github=.+; Path=\/; HttpOnly; SameSite=Lax; .*Secure$/,
    );
    expect(readGithubTrip(value(cookie), KEY, Date.now(), true)?.state).toBe(trip.state);

    // Someone else's own valid trip, set for the parent domain under the only name that allows.
    const theirs = startGithubTrip(KEY, "/sites", false).cookie;
    expect(value(theirs).startsWith("greatcms_github=")).toBe(true);
    expect(readGithubTrip(value(theirs), KEY, Date.now(), true)).toBeNull();
  });

  it("reads nothing from a cookie it did not sign", () => {
    for (const planted of ["a.b.c.d", "a.99999999999999.L3NpdGVz.x", "", "....", "%"]) {
      expect(readGithubTrip(`__Host-greatcms_github=${planted}`, KEY, Date.now(), true)).toBeNull();
      expect(readGithubTrip(`greatcms_github=${planted}`, KEY)).toBeNull();
    }
  });
});

describe("cookies the page reads for looks alone", () => {
  it("takes a theme only from the three it offers", () => {
    expect(themeOf("greatcms_theme=dark")).toBe("dark");
    for (const planted of [
      "greatcms_theme=darker",
      'greatcms_theme="><script>alert(1)</script>',
      "greatcms_theme=DARK",
      "greatcms_theme=",
      "greatcms_theme=%64ark",
      `greatcms_theme=${"a".repeat(100_000)}`,
    ]) {
      expect(themeOf(planted)).toBe("system");
    }
  });

  it("takes a pane's width only as a whole number inside its bounds", () => {
    expect(panesOf("greatcms_sidebar=300; greatcms_live=640")).toEqual({ sidebar: 300, live: 640 });
    for (const planted of [
      "greatcms_sidebar=99999; greatcms_live=1",
      "greatcms_sidebar=300px; greatcms_live=640x",
      "greatcms_sidebar=3e2; greatcms_live=-640",
      'greatcms_sidebar=300"><script>; greatcms_live=0x280',
      "greatcms_sidebar=; greatcms_live=NaN",
      "greatcms_sidebar=300.5; greatcms_live=Infinity",
    ]) {
      expect(panesOf(planted), planted).toEqual({ sidebar: undefined, live: undefined });
    }
  });

  it("draws the page whatever those cookies say", async () => {
    const session = value(createSessionCookie(KEY, { secure: true }));
    const planted =
      'greatcms_theme="><script>alert(1)</script>; greatcms_sidebar=1"><img src=x>; greatcms_live=</style><script>alert(2)</script>';
    for (const path of ["/", `/sites/${SITE_ID}/regions/home.hero`]) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const response = await visit(path, `${session}; ${planted}`);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const page = await response.text();
      expect(response.status).toBe(200);
      expect(page).not.toContain("alert(");
      expect(page).not.toContain("<img src=x>");
    }
  });
});

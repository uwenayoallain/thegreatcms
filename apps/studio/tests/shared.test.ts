/** What leaves the studio for people outside it: preview links, notifications, exports. */

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createShareToken, sessionKey } from "../src/auth.js";
import {
  type Notification,
  replyAddress,
  ResendNotifier,
  submissionHtml,
  toCsv,
  WebhookNotifier,
} from "../src/submissions.js";
import { type Fixture, makeSite, PASSWORD, SECRET, SITE_ID, signedIn } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text }
`;
const key = sessionKey(SECRET, PASSWORD);

let site: Fixture;
let app: ReturnType<typeof createApp>;
let sent: Notification[];

beforeEach(() => {
  site = makeSite({ schema: SCHEMA, devUrl: "https://preview.example.com" });
  sent = [];
  app = createApp({
    store: site.store,
    password: PASSWORD,
    secret: SECRET,
    publicUrl: "https://studio.example.com",
    cookieDomain: "example.com",
    notifier: { notify: async (message) => void sent.push(message) },
  });
});
afterEach(() => site.cleanup());

const page = async (response: Response) => new JSDOM(await response.text()).window.document;
const check = (uri: string, headers: Record<string, string> = {}) =>
  app.request("/auth/check", {
    headers: {
      "x-forwarded-host": "preview.example.com",
      "x-forwarded-proto": "https",
      "x-forwarded-uri": uri,
      ...headers,
    },
  });

describe("the page that makes a preview link", () => {
  it("is reached from the editor's preview, by a button that has a form to send", async () => {
    const document = await page(
      await app.request(`/sites/${SITE_ID}/regions/home.hero`, { headers: signedIn }),
    );
    const button = document.querySelector('button[title="Share a preview link"]')!;
    const form = document.getElementById(button.getAttribute("form")!) as HTMLFormElement;
    expect(form.getAttribute("action")).toBe(`/sites/${SITE_ID}/share`);
    expect(form.method).toBe("post");
    expect(form.closest("#editor-form")).toBeNull();
    expect(form.querySelector<HTMLInputElement>('input[name="path"]')?.value).toBe("/");
  });

  it("says what the link shows, how long it lasts and how it is taken back", async () => {
    const response = await app.request(`/sites/${SITE_ID}/share`, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ path: "/about" }),
    });
    const document = await page(response);
    const field = document.querySelector<HTMLInputElement>("#share-url")!;
    expect(field.readOnly).toBe(true);
    expect(field.value).toMatch(/^https:\/\/preview\.example\.com\/about\?greatcms-share=/);
    const text = document.querySelector("main")?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toMatch(/unpublished edits included/);
    expect(text).toMatch(/Seven days, until/);
    expect(text).toMatch(/Stop sharing ends this link and every other link made for Example/);
    expect(text).toMatch(/Links to other sites keep working/);
    expect(
      document.querySelector(`form[action="/sites/${SITE_ID}/share/stop"] button[type="submit"]`),
    ).not.toBeNull();
    const until = document.querySelector("time")?.getAttribute("datetime") ?? "";
    expect(Date.parse(until) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    // No script on this screen: the field is there to select and copy by hand.
    expect(document.querySelectorAll("script")).toHaveLength(0);
  });
});

describe("stopping a site's preview links", () => {
  const opens = async (host: string, token: string) =>
    (
      await app.request("/auth/check", {
        headers: {
          "x-forwarded-host": host,
          "x-forwarded-proto": "https",
          "x-forwarded-uri": "/",
          cookie: `greatcms_share=${encodeURIComponent(token)}`,
        },
      })
    ).status === 204;
  const linkFor = async (siteId: string) => {
    const response = await app.request(`/sites/${siteId}/share`, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ path: "/" }),
    });
    const field = (await page(response)).querySelector<HTMLInputElement>("#share-url")!;
    return new URL(field.value).searchParams.get("greatcms-share")!;
  };

  it("ends that site's links at once, and leaves another site's and later ones working", async () => {
    site.store.addSite({
      id: "site-2",
      name: "Other",
      path: site.root,
      devUrl: "https://other.example.com",
      createdAt: "2026-08-16",
    });
    const before = await linkFor(SITE_ID);
    const older = createShareToken(key, SITE_ID);
    const other = await linkFor("site-2");
    expect(await opens("preview.example.com", before)).toBe(true);
    expect(await opens("preview.example.com", older)).toBe(true);
    expect(await opens("other.example.com", other)).toBe(true);

    const stopped = await app.request(`/sites/${SITE_ID}/share/stop`, {
      method: "POST",
      headers: signedIn,
    });
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe(`/sites/${SITE_ID}/settings`);
    const flash = stopped.headers
      .getSetCookie()
      .find((value) => value.startsWith("greatcms_flash="))!
      .split(";")[0];
    const settings = await page(
      await app.request(`/sites/${SITE_ID}/settings`, {
        headers: { cookie: `${signedIn.cookie}; ${flash}` },
      }),
    );
    expect(settings.querySelector(".flash")?.textContent).toMatch(
      /Every preview link made for Example so far has stopped working/,
    );
    expect(
      settings.querySelector(`form[action="/sites/${SITE_ID}/share/stop"] button`),
    ).not.toBeNull();

    expect(await opens("preview.example.com", before)).toBe(false);
    expect(await opens("preview.example.com", older)).toBe(false);
    expect(await opens("other.example.com", other)).toBe(true);
    // Arriving by the link itself is told it no longer works, like any other dead link.
    const arrived = await check(`/?greatcms-share=${encodeURIComponent(before)}`);
    expect(arrived.headers.get("location")).toBe("https://studio.example.com/share");

    const after = await linkFor(SITE_ID);
    expect(after).not.toBe(before);
    expect(await opens("preview.example.com", after)).toBe(true);
    // A round cannot be claimed: the signature covers it.
    expect(await opens("preview.example.com", before.replace(/^site-1\./, "site-1.r1."))).toBe(
      false,
    );
  });

  it("is refused to someone who is not signed in", async () => {
    const response = await app.request(`/sites/${SITE_ID}/share/stop`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(site.store.shareRound(SITE_ID)).toBe(0);
  });
});

describe("what the person it was sent to sees", () => {
  const token = () => createShareToken(key, SITE_ID);

  it("opens the preview at an address with no token left in it", async () => {
    const first = await check(`/about?greatcms-share=${token()}&utm=1`);
    const redeem = new URL(first.headers.get("location")!);
    const second = await app.request(`${redeem.pathname}${redeem.search}`, {
      headers: { "user-agent": "Mozilla/5.0 (iPhone) Safari/605" },
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe("https://preview.example.com/about?utm=1");
  });

  it.each([
    ["expired", () => createShareToken(key, SITE_ID, Date.now() - 8 * 86_400_000)],
    ["made before the password changed", () => createShareToken("another key", SITE_ID)],
    ["cut short", () => token().slice(0, -6)],
    ["for a site no longer connected", () => createShareToken(key, "gone")],
  ])("is told a link that is %s no longer works, and what to ask for", async (_, make) => {
    const first = await check(`/?greatcms-share=${encodeURIComponent(make())}`);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("https://studio.example.com/share");

    const response = await app.request("/share");
    expect(response.status).toBe(403);
    const document = await page(response);
    expect(document.querySelector("h1")?.textContent).toBe("This preview link no longer works");
    const text = document.querySelector("main")?.textContent ?? "";
    expect(text).toMatch(/Ask the person who sent it for a new link/);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelector('a[href="/"]')).toBeNull();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex");
  });

  it("is told why the studio asks for a password once a link's week is over", async () => {
    const first = await check("/about");
    const signIn = new URL(first.headers.get("location")!);
    expect(signIn.pathname).toBe("/sign-in");
    const text =
      (await page(await app.request(`${signIn.pathname}${signIn.search}`))).querySelector("main")
        ?.textContent ?? "";
    expect(text.replace(/\s+/g, " ")).toMatch(
      /preview\.example\.com is a private preview.*ask the person who shared it for a new one/,
    );
  });

  it("gives a chat app a card about the preview, and no way in", async () => {
    const first = await check(`/drafts/secret-launch?greatcms-share=${token()}`);
    const redeem = new URL(first.headers.get("location")!);
    const response = await app.request(`${redeem.pathname}${redeem.search}`, {
      headers: { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    const html = await response.text();
    const document = new JSDOM(html).window.document;
    expect(document.title).toBe("Preview of Example");
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
      "Preview of Example",
    );
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toMatch(
      /noindex/,
    );
    const head = document.head.innerHTML;
    expect(head).not.toContain("secret-launch");
    expect(head).not.toContain("greatcms-share");
    expect(head).not.toContain(site.root);

    // A person whose browser was taken for one still gets in, by the link on the card.
    const open = document.querySelector("a")!.getAttribute("href")!;
    const opened = await app.request(open, {
      headers: { "user-agent": "Slackbot-LinkExpanding 1.0" },
    });
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe("https://preview.example.com/drafts/secret-launch");
  });
});

describe("a submission's notification", () => {
  const submit = (fields: Record<string, string>) =>
    app.request(`/f/${SITE_ID}/contact`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "evil.example" },
      body: new URLSearchParams(fields),
    });

  it("carries the fields, the visitor's address to reply to, and the studio's own inbox", async () => {
    await submit({ email: " grace@example.com ", message: "Hello\nthere", _redirect: "/thanks" });
    expect(sent).toHaveLength(1);
    const [message] = sent as [Notification];
    expect(message.subject).toBe("Example: new contact submission");
    expect(message.site).toBe("Example");
    expect(message.form).toBe("contact");
    expect(message.fields).toEqual({ email: " grace@example.com ", message: "Hello\nthere" });
    expect(message.replyTo).toBe("grace@example.com");
    expect(message.inbox).toBe(`https://studio.example.com/inbox?site=${SITE_ID}`);
  });

  it("replies to nobody when the address is not one address", () => {
    expect(replyAddress({ email: "a@example.com, b@example.com" })).toBeUndefined();
    expect(replyAddress({ email: "a@example.com\nBcc: b@example.com" })).toBeUndefined();
    expect(replyAddress({ email: "Grace <grace@example.com>" })).toBeUndefined();
    expect(replyAddress({ message: "write to grace@example.com" })).toBeUndefined();
    expect(replyAddress({ "E-mail": "grace@example.com" })).toBe("grace@example.com");
  });

  const message: Notification = {
    kind: "submission",
    subject: "Example: new contact\r\nBcc: x@example.com submission",
    lines: ["email: grace@example.com", "message: <b>Hi</b>"],
    site: "Example",
    form: "contact",
    fields: { email: "grace@example.com", message: '<b>Hi</b>\n"quoted" & more' },
    replyTo: "grace@example.com",
    inbox: "https://studio.example.com/inbox?site=site-1",
  };

  it("emails it as text and as HTML, with what the visitor typed escaped", async () => {
    let body: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response("{}");
    }) as unknown as typeof fetch;
    await new ResendNotifier(
      { apiKey: "k", from: "a@example.com", to: "b@example.com" },
      fetchImpl,
    ).notify(message);
    expect(body.subject).toBe("Example: new contact Bcc: x@example.com submission");
    expect(body.reply_to).toBe("grace@example.com");
    expect(body.text).toContain("message: <b>Hi</b>");
    expect(body.text).toContain(
      "Read it in the studio: https://studio.example.com/inbox?site=site-1",
    );
    expect(body.html).toBe(submissionHtml(message));
    expect(body.html).not.toContain("<b>Hi</b>");
    expect(body.html).toContain("&#60;b&#62;Hi&#60;/b&#62;");
    expect(body.html).toContain("&#34;quoted&#34; &#38; more");
  });

  it("posts a webhook chat apps can read and programs can parse", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const long = { ...message, lines: ["x".repeat(5000)] };
    await new WebhookNotifier("https://hooks.example.com/in", fetchImpl).notify(long);
    expect(body).toMatchObject({
      kind: "submission",
      site: "Example",
      form: "contact",
      fields: message.fields,
      replyTo: "grace@example.com",
    });
    expect(String(body.text)).toHaveLength(long.subject.length + 1 + 5000);
    expect(String(body.content)).toHaveLength(2000);
  });
});

const row = (data: Record<string, string>, from = "Example") => ({
  createdAt: "2026-11-10 00:01:35",
  form: "contact",
  site: from,
  data,
});

describe("the CSV export", () => {
  it("names its columns, says which site and when without guessing a time zone", () => {
    const csv = toCsv([row({ message: "Hi" }), row({ message: "Yo" }, "Other")]);
    expect(csv.split("\r\n")).toEqual([
      '"Received (UTC)","Site","Form","message"',
      '"2026-11-10T00:01:35Z","Example","contact","Hi"',
      '"2026-11-10T00:01:35Z","Other","contact","Yo"',
      "",
    ]);
  });

  it("stops every cell a spreadsheet would run, a visitor's field name included", () => {
    const csv = toCsv([
      row(
        { "=HYPERLINK(1)": "x", a: "+1", b: "-2", c: "@SUM(A1)", d: "  =1+1", e: "\t=1" },
        "=site",
      ),
    ]);
    const cells = csv.split("\r\n").flatMap((line) => line.split('","'));
    expect(cells.filter((cell) => /^"?\s*[=+\-@\t]/.test(cell))).toEqual([]);
    expect(csv).toContain(`"'=HYPERLINK(1)"`);
    expect(csv).toContain(`"'  =1+1"`);
  });
});

describe("what a publish is recorded as", () => {
  it("commits under the editor's own name, with a message that names the content", async () => {
    await app.request(`/sites/${SITE_ID}/regions/home.hero`, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ headSha: site.head(), action: "publish", "f[heading]": "Hello" }),
    });
    const { execFileSync } = await import("node:child_process");
    const log = execFileSync("git", ["log", "-1", "--format=%s%n%b"], {
      cwd: site.root,
      encoding: "utf8",
    });
    expect(log.trim()).toBe("content: update home.hero");
    expect(log).not.toMatch(/generated|co-authored/i);
    expect(sent.at(-1)).toMatchObject({
      kind: "publish",
      subject: "Example: studio published home.hero",
    });
  });
});

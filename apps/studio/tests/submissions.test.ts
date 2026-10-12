/** The dynamic layer: what a managed site posts, what lands in the inbox, and what never should. */

import { beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import axe from "axe-core";
import { createApp } from "../src/app.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";
import { assessSpam, RateLimiter, toCsv } from "../src/submissions.js";

const PASSWORD = "a-long-password";
const SECRET = "test-secret";
const SITE = {
  id: "site-1",
  name: "Example",
  path: "/tmp/not-read-by-these-tests",
  devUrl: "",
  createdAt: "2026-08-12",
};

let store: Store;
let app: ReturnType<typeof createApp>;
let notified: Array<{ subject: string; lines: string[] }>;

beforeEach(() => {
  store = new Store(":memory:");
  store.addSite(SITE);
  notified = [];
  app = createApp({
    store,
    password: PASSWORD,
    secret: SECRET,
    notifier: {
      notify: async (message) => {
        notified.push(message);
      },
    },
  });
});

const signedIn = {
  cookie: createSessionCookie(sessionKey(SECRET, PASSWORD)).split(";")[0] as string,
};

function submit(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return app.request("/f/site-1/contact", {
    method: "POST",
    // A real browser posting from another origin — exactly the case the studio must.
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://example.com",
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

describe("receiving a submission", () => {
  it("accepts a cross-origin form post from a managed site", async () => {
    const response = await submit({ name: "Ada", email: "ada@example.com", message: "Hello" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Thank you");

    const [stored] = store.listSubmissions();
    expect(stored?.data).toEqual({ name: "Ada", email: "ada@example.com", message: "Hello" });
    expect(stored?.form).toBe("contact");
  });

  it("needs no session — visitors are not signed in", async () => {
    expect((await submit({ message: "Anonymous" })).status).toBe(200);
  });

  it("redirects back to the site when asked, but only to a same-site path", async () => {
    const ok = await submit({ message: "Hi", _redirect: "/thanks" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("https://example.com/thanks");

    const evil = await submit({ message: "Hi", _redirect: "https://evil.example/phish" });
    expect(evil.status).toBe(200);

    const protocolRelative = await submit({ message: "Hi", _redirect: "//evil.example" });
    expect(protocolRelative.status).toBe(200);
  });

  it("sends the visitor to the path on the site they submitted from, not on the studio", async () => {
    const response = await app.request("/f/site-1/contact", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://www.example.org",
      },
      body: new URLSearchParams({ message: "Hi", _redirect: "/thanks/?sent=1" }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://www.example.org/thanks/?sent=1");
  });

  it("rejects submissions for an unknown site", async () => {
    const response = await app.request("/f/nope/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: "Hi" }),
    });
    expect(response.status).toBe(404);
  });

  it("emails a notification for real messages but not for spam", async () => {
    await submit({ name: "Ada", message: "Genuine" });
    expect(notified).toHaveLength(1);
    expect(notified[0]?.subject).toContain("Example");

    await submit({ message: "Buy things", company: "bot filled this" });
    expect(notified).toHaveLength(1);
  });

  it("stores spam rather than dropping it, so nothing is lost silently", async () => {
    await submit({ message: "Spam", company: "bot" });
    expect(store.listSubmissions()).toHaveLength(0);
    expect(store.listSubmissions({ includeSpam: true })).toHaveLength(1);
  });

  it("rate limits a flood without blocking normal use", async () => {
    const limited = createApp({
      store,
      password: PASSWORD,
      secret: SECRET,
      rateLimiter: new RateLimiter(2, 60_000),
    });
    const post = () =>
      limited.request("/f/site-1/contact", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": "203.0.113.9",
        },
        body: new URLSearchParams({ message: "Hi" }),
      });

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });
});

describe("spam scoring", () => {
  it("flags a filled honeypot", () => {
    const result = assessSpam({ company: "bot", message: "hi" });
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.reasons[0]).toContain("honeypot");
  });

  it("flags a form submitted faster than a person could type", () => {
    const now = 1_000_000;
    expect(
      assessSpam({ message: "hi", _t: String(now - 200) }, { now }).score,
    ).toBeGreaterThanOrEqual(3);
    expect(assessSpam({ message: "hi", _t: String(now - 30_000) }, { now }).score).toBe(0);
  });

  it("leaves an ordinary message alone", () => {
    expect(assessSpam({ name: "Ada", message: "Could we talk next week?" }).score).toBe(0);
  });

  it("is suspicious of link-stuffed messages", () => {
    const links = "https://a.example https://b.example https://c.example https://d.example";
    expect(assessSpam({ message: links }).score).toBeGreaterThan(0);
  });
});

describe("the inbox", () => {
  beforeEach(async () => {
    await submit({ name: "Ada", message: "First" });
    await submit({ name: "Grace", message: "Second" });
  });

  it("lists submissions newest first", async () => {
    const response = await app.request("/inbox", { headers: signedIn });
    const body = await response.text();
    expect(body.indexOf("Grace")).toBeLessThan(body.indexOf("Ada"));
  });

  it("requires a session", async () => {
    const response = await app.request("/inbox");
    expect(response.status).toBe(303);
  });

  it("marks a submission read and back to unread", async () => {
    const [latest] = store.listSubmissions();
    await app.request(`/inbox/${latest?.id}/read`, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ read: "1" }),
    });
    expect(store.getSubmission(latest?.id as number)?.readAt).toBeTruthy();

    await app.request(`/inbox/${latest?.id}/read`, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ read: "0" }),
    });
    expect(store.getSubmission(latest?.id as number)?.readAt).toBeNull();
  });

  it("deletes a submission", async () => {
    const [latest] = store.listSubmissions();
    await app.request(`/inbox/${latest?.id}/delete`, { method: "POST", headers: signedIn });
    expect(store.getSubmission(latest?.id as number)).toBeNull();
  });

  it("shows the unread count on the sites page", async () => {
    const body = await (await app.request("/", { headers: signedIn })).text();
    const count = new JSDOM(body).window.document.querySelector(".count");
    expect(count?.textContent?.replace(/\s+/g, " ").trim()).toBe("2 unread");
  });

  it("exports CSV", async () => {
    const response = await app.request("/inbox.csv", { headers: signedIn });
    expect(response.headers.get("content-type")).toContain("text/csv");
    const csv = await response.text();
    expect(csv.split("\n")[0]).toBe('"received","form","message","name"');
    expect(csv).toContain('"Grace"');
  });

  it("has no axe violations", async () => {
    const response = await app.request("/inbox", { headers: signedIn });
    const { window } = new JSDOM(await response.text(), { url: "https://studio.test/" });
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });

    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("CSV export", () => {
  it("neutralises cells a spreadsheet would run as a formula", () => {
    const csv = toCsv([
      { createdAt: "2026-08-12", form: "contact", data: { message: "=cmd|calc" } },
    ]);
    expect(csv).toContain(`"'=cmd|calc"`);
  });

  it("escapes quotes rather than breaking the row", () => {
    const csv = toCsv([
      { createdAt: "2026-08-12", form: "contact", data: { message: 'She said "hi"' } },
    ]);
    expect(csv).toContain('"She said ""hi"""');
  });
});

describe("a site's overall budget", () => {
  it("stops storing submissions past the site's daily limit, whoever sends them", async () => {
    const capped = createApp({
      store,
      password: "x".repeat(16),
      secret: "s",
      trustProxy: true,
      siteSubmissionLimiter: new RateLimiter(3, 60_000),
    });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a budget is a claim about order
      const response = await capped.request("/f/site-1/contact", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": `198.51.100.${i}`,
        },
        body: new URLSearchParams({ message: `Hi ${i}` }),
      });
      codes.push(response.status);
    }

    expect(codes.filter((code) => code === 429)).toHaveLength(2);
    expect(store.listSubmissions()).toHaveLength(3);
  });

  it("keeps storing, but stops emailing, past the hourly notification limit", async () => {
    const sent: string[] = [];
    const quiet = createApp({
      store,
      password: "x".repeat(16),
      secret: "s",
      trustProxy: true,
      notifier: { notify: async (message) => void sent.push(message.subject) },
      notificationLimiter: new RateLimiter(2, 60_000),
    });
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a budget is a claim about order
      await quiet.request("/f/site-1/contact", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": `198.51.100.${i}`,
        },
        body: new URLSearchParams({ message: `Hi ${i}`, _t: String(Date.now() - 10_000) }),
      });
    }

    expect(store.listSubmissions()).toHaveLength(4);
    expect(sent).toHaveLength(2);
  });
});

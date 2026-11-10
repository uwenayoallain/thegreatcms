/** Defensive regression tests asserting studio hardening and session security properties. */

/* oxlint-disable no-await-in-loop -- sequential order matters for rate-limiting and route enumeration */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  checkPassword,
  createSessionCookie,
  createShareToken,
  editorStamp,
  hashPassword,
  readShareToken,
  sessionKey,
  verifyPassword,
} from "../src/auth.js";
import { makeSite, PASSWORD, SECRET, signedIn, type Fixture } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }
      subtitle: { type: text }
collections:
  blog:
    label: Blog
    path: content/blog
    format: markdown
    body: content
    slug: title
    fields:
      title: { type: text, required: true }
      date: { type: date }
      content: { type: richtext }
`;

let site: Fixture;

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
});

afterEach(() => {
  site.cleanup();
});

const assertSecurityHeaders = (headers: Headers) => {
  expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("referrer-policy")).toBe("same-origin");
};

describe("property 1: csrf and same-origin check on POST routes", () => {
  const routes = [
    { name: "theme", path: "/theme", body: { theme: "dark" } },
    { name: "share", path: "/sites/site-1/share", body: { path: "/" } },
    {
      name: "editors add",
      path: "/editors",
      body: { name: "Test", email: "test@example.com", password: "password12345" },
    },
    { name: "editors password", path: "/editors/1/password", body: { password: "password12345" } },
    { name: "editors delete", path: "/editors/1/delete", body: {} },
    { name: "sign-in", path: "/sign-in", body: { password: PASSWORD } },
    { name: "sign-out", path: "/sign-out", body: {} },
    { name: "inbox read", path: "/inbox/1/read", body: { read: "1" } },
    { name: "inbox delete", path: "/inbox/1/delete", body: {} },
    { name: "sites new", path: "/sites", body: { name: "New", path: "/tmp/foo" } },
    { name: "sites settings", path: "/sites/site-1/settings", body: { name: "Updated" } },
    { name: "sites cancel job", path: "/sites/site-1/scheduled/job-1/cancel", body: {} },
    { name: "sites rollback", path: "/sites/site-1/rollback", body: { to: "abc" } },
    { name: "sites push", path: "/sites/site-1/push", body: {} },
    { name: "sites delete", path: "/sites/site-1/delete", body: {} },
    {
      name: "collection entry delete",
      path: "/sites/site-1/collections/blog/entry/delete",
      body: {},
    },
    {
      name: "collection entry save",
      path: "/sites/site-1/collections/blog/entry",
      body: { "f[title]": "New entry" },
    },
    {
      name: "region save",
      path: "/sites/site-1/regions/home.hero",
      body: { "f[heading]": "New heading" },
    },
    {
      name: "region draft save",
      path: "/sites/site-1/regions/home.hero/draft",
      body: { "f[heading]": "Draft" },
    },
    {
      name: "region draft discard",
      path: "/sites/site-1/regions/home.hero/draft/discard",
      body: {},
    },
    {
      name: "collection draft save",
      path: "/sites/site-1/collections/blog/entry/draft",
      body: { "f[title]": "Draft" },
    },
    {
      name: "collection draft discard",
      path: "/sites/site-1/collections/blog/entry/draft/discard",
      body: {},
    },
    {
      name: "region restore",
      path: "/sites/site-1/regions/home.hero/history/abc/restore",
      body: {},
    },
    {
      name: "collection restore",
      path: "/sites/site-1/collections/blog/entry/history/abc/restore",
      body: {},
    },
  ];

  for (const route of routes) {
    it(`refuses cross-origin post with untrusted origin to ${route.path}`, async () => {
      const response = await site.app.request(route.path, {
        method: "POST",
        headers: {
          ...signedIn,
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
        body: new URLSearchParams(route.body),
      });
      expect(response.status).toBe(403);
    });

    it(`refuses cross-origin post with untrusted referer to ${route.path}`, async () => {
      const response = await site.app.request(route.path, {
        method: "POST",
        headers: {
          ...signedIn,
          "content-type": "application/x-www-form-urlencoded",
          referer: "https://evil.example/attacker-page",
        },
        body: new URLSearchParams(route.body),
      });
      expect(response.status).toBe(403);
    });
  }
});

describe("property 2: sign-in rate limiting and constant-time password comparison", () => {
  it("sign-in throttles and returns 429 with retry-after after repeated wrong attempts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await site.app.request("/sign-in", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: `wrong-${i}` }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401));
    expect(statuses.slice(10)).toEqual([429, 429]);

    const blocked = await site.app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "wrong" }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("password verification code uses timingSafeEqual for constant-time comparison", () => {
    const authSource = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
    expect(authSource).toContain("timingSafeEqual");
    expect(authSource).toContain("function constantTimeEqual");

    expect(checkPassword("attempt", PASSWORD)).toBe(false);
    expect(checkPassword(PASSWORD, PASSWORD)).toBe(true);

    const storedHash = hashPassword("secret-pass-123");
    expect(verifyPassword("secret-pass-123", storedHash)).toBe(true);
    expect(verifyPassword("wrong-pass", storedHash)).toBe(false);
  });
});

describe("property 3: session cookie flags and server-side invalidation on sign-out", () => {
  it("session cookies are HttpOnly, SameSite, and Secure behind HTTPS", async () => {
    const res = await site.app.request("https://studio.example.com/sign-in", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://studio.example.com",
      },
      body: new URLSearchParams({ password: PASSWORD }),
    });

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("greatcms_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("signing out invalidates the session server-side so an old cookie no longer works", async () => {
    // 1. Initial request with valid session succeeds
    const initial = await site.app.request("/sites/site-1", { headers: signedIn });
    expect(initial.status).toBe(200);

    // 2. Client logs out via POST /sign-out
    const signOutRes = await site.app.request("/sign-out", {
      method: "POST",
      headers: { ...signedIn, origin: "http://localhost" },
    });
    expect(signOutRes.status).toBe(303);
    expect(signOutRes.headers.get("location")).toBe("/sign-in");

    // 3. Reusing the old cookie must be rejected by the server
    const reused = await site.app.request("/sites/site-1", { headers: signedIn });
    expect(reused.status).toBe(303);
    expect(reused.headers.get("location")).toContain("/sign-in");
  });
});

describe("property 4: share links and editor access control", () => {
  it("share tokens are long, random, expire, and scoped to the site", () => {
    const signingKey = sessionKey(SECRET, PASSWORD);
    const token = createShareToken(signingKey, "site-1");

    expect(token.length).toBeGreaterThan(32);
    expect(readShareToken(token, signingKey)).toBe("site-1");

    // Token cannot access another site or be forged
    expect(readShareToken("site-2.9999999999999.invalid", signingKey)).toBeNull();

    // Expired token is rejected
    const expiredToken = createShareToken(signingKey, "site-1", Date.now() - 8 * 86_400_000);
    expect(readShareToken(expiredToken, signingKey)).toBeNull();
  });

  it("a regular editor cannot reach admin-only routes", async () => {
    const editorPassword = "editor-password-123";
    const signingKey = sessionKey(SECRET, PASSWORD);
    site.store.addEditor({
      name: "Alice Editor",
      email: "alice@example.com",
      passwordHash: hashPassword(editorPassword),
      allSites: true,
    });
    const editor = site.store.findEditor("alice@example.com");
    expect(editor).toBeDefined();

    const stamp = editorStamp(signingKey, editor!.passwordHash);
    const editorCookie = createSessionCookie(signingKey, {
      actor: `editor:${editor!.id}`,
      stamp,
    }).split(";")[0]!;

    const headers = { cookie: editorCookie, origin: "http://localhost" };

    // Regular editor can access content editor screens
    const sitePage = await site.app.request("/sites/site-1", { headers: { cookie: editorCookie } });
    expect(sitePage.status).toBe(200);

    // Admin routes must refuse regular editor with 403
    const adminRoutes = [
      { method: "GET", path: "/editors" },
      {
        method: "POST",
        path: "/editors",
        body: { name: "Bob", email: "bob@example.com", password: "password12345" },
      },
      { method: "POST", path: `/editors/${editor!.id}/delete`, body: {} },
      { method: "GET", path: "/sites/site-1/settings" },
      { method: "POST", path: "/sites/site-1/settings", body: { name: "Renamed Site" } },
      { method: "POST", path: "/sites/site-1/delete", body: {} },
      { method: "GET", path: "/sites/new" },
      { method: "POST", path: "/sites", body: { name: "Another Site", path: "/tmp/site2" } },
    ];

    for (const route of adminRoutes) {
      const res = await site.app.request(route.path, {
        method: route.method,
        headers: {
          ...headers,
          ...(route.method === "POST"
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(route.body ? { body: new URLSearchParams(route.body) } : {}),
      });
      expect(res.status).toBe(403);
    }
  });
});

describe("property 5: redirect parameter restrictions after sign-in", () => {
  const invalidNextTargets = [
    "//example.com",
    "https://example.com",
    "/\\example.com",
    "///example.com",
    "https://evil.example/login",
    "/\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/\tevil.example",
  ];

  for (const next of invalidNextTargets) {
    it(`refuses off-site redirect target: ${next}`, async () => {
      const res = await site.app.request("/sign-in", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: PASSWORD, next }),
      });

      expect(res.status).toBe(303);
      const location = res.headers.get("location");
      expect(location).toBe("/sites/site-1");
    });
  }

  it("permits safe local redirect targets", async () => {
    const res = await site.app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD, next: "/sites/site-1/regions/home.hero" }),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sites/site-1/regions/home.hero");
  });
});

describe("property 6: security headers on HTML pages including error pages", () => {
  it("sign-in HTML page carries security headers", async () => {
    const res = await site.app.request("/sign-in");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    assertSecurityHeaders(res.headers);
  });

  it("authenticated HTML page carries security headers", async () => {
    const res = await site.app.request("/sites/site-1", { headers: signedIn });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    assertSecurityHeaders(res.headers);
  });

  it("404 Not Found HTML error page carries security headers", async () => {
    const res = await site.app.request("/does-not-exist", { headers: signedIn });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    assertSecurityHeaders(res.headers);
  });

  it("403 Forbidden HTML error page carries security headers", async () => {
    const signingKey = sessionKey(SECRET, PASSWORD);
    site.store.addEditor({ name: "Ed", email: "ed@example.com", passwordHash: "dummy", allSites: true });
    const stamp = editorStamp(signingKey, "dummy");
    const editorCookie = createSessionCookie(signingKey, { actor: "editor:1", stamp }).split(
      ";",
    )[0]!;

    const res = await site.app.request("/editors", { headers: { cookie: editorCookie } });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    assertSecurityHeaders(res.headers);
  });

  it("401 Unauthorized HTML error page carries security headers", async () => {
    const res = await site.app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    assertSecurityHeaders(res.headers);
  });

  it("422 Unprocessable Entity HTML error page carries security headers", async () => {
    const res = await site.app.request("/sites", {
      method: "POST",
      headers: {
        ...signedIn,
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      },
      body: new URLSearchParams({ name: "Site without path", path: "" }),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("text/html");
    assertSecurityHeaders(res.headers);
  });
});

describe("property 7: public form intake endpoint hardening", () => {
  it("caps request body size to 64KB", async () => {
    const res = await site.app.request("/f/site-1/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: "x".repeat(100_000) }),
    });

    expect(res.status).toBe(413);
    expect(site.store.listSubmissions({})).toEqual([]);
  });

  it("caps field count to 64 fields", async () => {
    const body = new URLSearchParams();
    for (let i = 0; i < 70; i += 1) body.set(`field_${i}`, `val_${i}`);

    const res = await site.app.request("/f/site-1/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "0" },
      body,
    });

    expect(res.status).toBe(413);
    expect(site.store.listSubmissions({})).toEqual([]);
  });

  it("safely ignores internal and unknown machinery fields", async () => {
    const res = await site.app.request("/f/site-1/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Ada",
        email: "ada@example.com",
        _redirect: "/thanks",
        _t: "12345678",
        _custom_machinery: "ignored",
        company: "", // honeypot
        __proto__: "malicious",
      }),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/thanks");
    const submissions = site.store.listSubmissions({});
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.data).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(submissions[0]!.data._redirect).toBeUndefined();
    expect(submissions[0]!.data._t).toBeUndefined();
    expect(submissions[0]!.data.company).toBeUndefined();
  });

  it("escapes HTML in stored submissions when displayed in inbox", async () => {
    await site.app.request("/f/site-1/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "XSS Test",
        message: '<script>alert("xss")</script><img src="x" onerror="alert(1)">',
      }),
    });

    const res = await site.app.request("/inbox", { headers: signedIn });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("xss")</script>');
  });

  it("does not let a submitted value inject lines into email notification headers", async () => {
    const notified: Array<{ subject: string; lines: string[] }> = [];
    const app = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      notifier: {
        notify: async (msg) => {
          notified.push(msg);
        },
      },
    });

    await app.request("/f/site-1/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Alice\r\nBcc: evil@example.com",
        message: "Hello\r\nSubject: Injected subject",
        _t: String(Date.now() - 10_000),
      }),
    });

    expect(notified).toHaveLength(1);
    // Subject header line must remain intact and clean
    expect(notified[0]!.subject).toBe("Example: new contact submission");
    expect(notified[0]!.subject).not.toContain("\r");
    expect(notified[0]!.subject).not.toContain("\n");
  });
});

describe("property 8: oversized or malformed request bodies get 4xx, not 500", () => {
  it("malformed form body on /sign-in gets 4xx not 500", async () => {
    const res = await site.app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=boundary" },
      body: "invalid-multipart-payload-without-boundary",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("malformed form body on authenticated POST route gets 4xx not 500", async () => {
    const res = await site.app.request("/sites", {
      method: "POST",
      headers: {
        ...signedIn,
        "content-type": "multipart/form-data; boundary=boundary",
        origin: "http://localhost",
      },
      body: "invalid-multipart-payload-without-boundary",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("oversized streaming body on POST route gets 4xx", async () => {
    const chunk = new TextEncoder().encode(`theme=dark&extra=${"x".repeat(32 * 1024)}`);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });

    const res = await site.app.request("/theme", {
      method: "POST",
      headers: {
        ...signedIn,
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      },
      body,
      duplex: "half",
    } as RequestInit);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

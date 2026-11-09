/** The studio's HTTP surface. */

import { applyBlockAction, applyNestedBlockAction, nestedParentBlock } from "./block-edits.js";
import { readLive, requestRollback } from "./deploys.js";
import {
  DEV_URL_ERROR,
  formEntries,
  isDirectory,
  isHttpUrl,
  isSafeRedirect,
  readLimited,
  submissionId,
  submittingOrigin,
} from "./http.js";
import {
  committedPreviews,
  ExpiredMediaError,
  pendingPreviews,
  referencedMedia,
  retainedMedia,
} from "./uploads.js";
import { regionsElsewhere } from "./elsewhere.js";
import { searchSite } from "./search.js";
import { studioTimeZone, zonedToEpoch } from "./schedule.js";
import {
  isBlocksRegion,
  isSafeSlug,
  REGION_ID_RE,
  regionFilePath,
  type CollectionDef,
  type CmsConfig,
  type RegionDocument,
  validateFields,
  previewPath,
  resolveRegion,
  validateRegion,
} from "@greatcms/spec";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { setFlagsFromString } from "node:v8";
import {
  checkPassword,
  clearPreviewCookie,
  clearSessionCookie,
  createPreviewCookie,
  createSessionCookie,
  editorStamp,
  hashPassword,
  isSameOrigin,
  randomSecret,
  createShareToken,
  readPreviewSession,
  readSession,
  readShareCookie,
  readShareToken,
  type Session,
  sessionKey,
  shareCookie,
  verifyPassword,
} from "./auth.js";
import type { Site, Store } from "./db.js";
import { decodeBlocks, decodeForm } from "./form.js";
import { ALLOWED_TYPES, MAX_BYTES, UploadError, type UploadResult } from "./media.js";
import {
  assessSpam,
  contentFields,
  type Notifier,
  RateLimiter,
  SPAM_THRESHOLD,
  toCsv,
} from "./submissions.js";
import { SiteClient, type SiteContext, entryTitle } from "./sites.js";
import { type Author, ConflictError } from "./repo.js";
import { type Viewer, withViewer } from "./views/viewer.js";
import { THEME_COOKIE, THEMES, themeOf, withTheme } from "./views/theme.js";
import { panesOf, withChrome } from "./views/chrome.js";
import { errorsByPath } from "./views/fields.js";
import { page, type PageOptions } from "./views/layout.js";
import { asset, compressed, icon, ICONS } from "./assets.js";
import { editorsPage, sharePage, signInPage } from "./views/account-pages.js";
import { collectionPage, editEntryPage } from "./views/collection-pages.js";
import { inboxPage } from "./views/inbox-page.js";
import { editRegionPage } from "./views/region-page.js";
import { sitePage } from "./views/site-page.js";
import { newSitePage, sitesPage } from "./views/sites-pages.js";
import { siteTile } from "./views/pixel.js";
import { findSiteIcon } from "./site-icon.js";
import { Liveness } from "./liveness.js";
import { historyPage, searchPage } from "./views/tool-pages.js";

// A schema's `pattern` comes from the repository and runs on every save. One that backtracks
// without end, like `^(a+)+$`, is handed to V8's linear-time engine instead of hanging the server.
setFlagsFromString("--enable-experimental-regexp-engine-on-excessive-backtracks");

export interface AppOptions {
  store: Store;
  /** The zone "publish later" times are typed in; defaults to STUDIO_TIMEZONE or the server's. */
  timeZone?: string;
  password: string;
  secret: string;
  /** Injected in tests so routes can be driven without touching the network. */
  fetch?: typeof globalThis.fetch;
  /** Optional email notifier for new submissions. */
  notifier?: Notifier;
  rateLimiter?: RateLimiter;
  signInLimiter?: RateLimiter;
  /**
   * Whether a forwarding header may name the client. Off by default: when the
   * studio is reachable directly, anyone can set `x-forwarded-for` and give
   * themselves a fresh rate-limit bucket per request.
   */
  trustProxy?: boolean | "cloudflare";
  /**
   * Where browsers reach this studio, e.g. `https://studio.example.com`. Needed so a
   * reverse proxy's forward-auth check can send a signed-out visitor here to sign in.
   */
  publicUrl?: string;
  /**
   * The parent domain the session cookie is set for, e.g. `example.com`, so the proxy
   * can let the same sign-in through to `preview.example.com`. Unset: this host only.
   */
  cookieDomain?: string;
  /** Where this server reaches a site's dev server, by site id, when browsers reach it elsewhere. */
  probeUrls?: ReadonlyMap<string, string>;
  /** Submissions one site may store per day, whoever sends them. Injected by tests. */
  siteSubmissionLimiter?: RateLimiter;
  /** Notification emails one site may send per hour. Injected by tests. */
  notificationLimiter?: RateLimiter;
}

/** Bodies a public visitor can post, past which this is not a contact form. */
const MAX_SUBMISSION_BYTES = 64 * 1024;
/** A password form is a few hundred bytes; anything near this is not a sign-in. */
const MAX_SIGN_IN_BYTES = 4 * 1024;
/** Any other form: a few kilobytes of fields, or on an editor, a few full-size images with them. */
const MAX_FORM_BYTES = 1024 * 1024;
const MAX_EDITOR_BYTES = 6 * MAX_BYTES;
/** What a committed upload can be previewed as: anything the studio accepts, plus SVG a developer committed. */
const MEDIA_TYPES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(ALLOWED_TYPES).map(([type, extension]) => [extension, type]),
  ),
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};
const MAX_SUBMISSION_FIELDS = 64;

type Variables = { actor: string; viewer: Viewer; session: string };

export function createApp(options: AppOptions) {
  const { store, password, secret } = options;
  const app = new Hono<{ Variables: Variables }>();
  const limiter = options.rateLimiter ?? new RateLimiter();
  const liveness = new Liveness(options.probeUrls);
  // Per-address limits stop one sender; these stop many senders filling the inbox and the mail quota.
  const siteSubmissions = options.siteSubmissionLimiter ?? new RateLimiter(1000, 24 * 60 * 60_000);
  const notifications = options.notificationLimiter ?? new RateLimiter(60, 60 * 60_000);
  // Ten guesses per quarter hour: no bother to a person who mistyped, a wall to a script.
  const signInLimiter = options.signInLimiter ?? new RateLimiter(10, 15 * 60_000);
  const signingKey = sessionKey(secret, password);

  /** Who is asking, for rate limiting. */
  const addressOf = (c: { req: { header(name: string): string | undefined }; env: unknown }) => {
    if (options.trustProxy === "cloudflare") {
      const connecting = c.req.header("cf-connecting-ip")?.trim();
      if (connecting) return connecting;
    }
    if (options.trustProxy) {
      // The proxy appends the address it saw; anything to the left of it is the visitor's to forge.
      const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
      if (forwarded) return forwarded;
    }
    const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming
      ?.socket;
    return socket?.remoteAddress ?? "unknown";
  };

  /** Where visitors' browsers reach this studio, for the form address a site should use. */
  const publicOrigin = (c: { req: { header(name: string): string | undefined; url: string } }) => {
    if (options.publicUrl) return options.publicUrl;
    const host = options.trustProxy ? c.req.header("x-forwarded-host") : undefined;
    if (!host) return new URL(c.req.url).origin;
    return `${c.req.header("x-forwarded-proto") === "https" ? "https" : "http"}://${host}`;
  };

  /** Whether this request arrived over TLS, deciding the cookie's Secure flag. */
  const isSecure = (c: { req: { header(name: string): string | undefined; url: string } }) =>
    options.trustProxy && c.req.header("x-forwarded-proto")
      ? c.req.header("x-forwarded-proto") === "https"
      : new URL(c.req.url).protocol === "https:";

  /**
   * Headers that cost nothing and remove whole classes of attack.
   *
   * `frame-ancestors` stops the studio being framed, so a page cannot overlay
   * its own UI on top of Publish or Disconnect. `form-action 'self'` means a
   * hijacked form cannot post your session anywhere else. `script-src 'self'`
   * confines the page to the two bundles this app serves.
   *
   * `style-src` keeps 'unsafe-inline' for one reason: ProseMirror sets
   * `style` attributes while it measures and positions things. The stylesheet
   * itself is served as a file, so that allowance is the only inline style left.
   */
  const parentDomain = options.cookieDomain?.replace(/^\./, "");
  const formAction = parentDomain
    ? `form-action 'self' https://${parentDomain} https://*.${parentDomain} http://${parentDomain} http://*.${parentDomain}`
    : "form-action 'self'";

  app.use("*", async (c, next) => {
    await next();

    // Only documents: the asset route sets its own, and 304s must stay small.
    const type = c.res.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return;

    c.res.headers.set(
      "content-security-policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        // The live preview frames the operator's own dev server, wherever it
        // runs. Naming the schemes still rules out javascript: and data:.
        "frame-src 'self' http: https:",
        "img-src 'self' data: http: https:",
        "connect-src 'self'",
        formAction,
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    );
    c.res.headers.set("x-content-type-options", "nosniff");
    // A tab the studio opens, such as the site itself, gets no handle back on the signed-in window.
    c.res.headers.set("cross-origin-opener-policy", "same-origin");
    // `same-origin`, not `no-referrer`. With no-referrer Chrome sends
    // `Origin: null` on a same-origin form post, which the CSRF check above
    // refuses: every form in this app would break for anyone without
    // JavaScript. This keeps the referrer inside the studio and sends none to
    // anywhere else, which is the part that was actually worth having.
    c.res.headers.set("referrer-policy", "same-origin");
    // A studio is never a search result, and never a shared browser's history.
    c.res.headers.set("cache-control", "no-store");
    // Once a browser has reached the studio over TLS, it never sends a password over plain HTTP.
    if (isSecure(c)) c.res.headers.set("strict-transport-security", "max-age=31536000");
  });
  // After the headers above: registered before them, compress drops them on the Node server.
  // Pages are small; the editor bundle is not, and a remote studio is often on a slow link.
  app.use("*", compress());

  // No body is read whole into memory unbounded: the editors take uploads, every other form is small.
  const small = bodyLimit({
    maxSize: MAX_FORM_BYTES,
    onError: (c) => c.text("That form is too large.", 413),
  });
  const large = bodyLimit({
    maxSize: MAX_EDITOR_BYTES,
    onError: (c) => c.text("Those files are too large to send at once.", 413),
  });
  app.use("*", (c, next) => {
    // Public forms and sign-in measure their own, smaller bodies as they stream in.
    if (c.req.method !== "POST" || c.req.path === "/sign-in" || c.req.path.startsWith("/f/"))
      return next();
    return /^\/sites\/[^/]+\/(regions|collections|settings)\//.test(`${c.req.path}/`)
      ? large(c, next)
      : small(c, next);
  });

  // A body the form parser cannot read is the sender's mistake, not the server's.
  app.onError((error, c) => {
    if (error instanceof TypeError && /form ?data|parse body|boundary/i.test(error.message)) {
      return c.text("That form could not be read.", 400);
    }
    process.stderr.write(`${error.stack ?? error}\n`);
    return c.text("Something went wrong in the studio.", 500);
  });

  /** The public submission endpoint. */
  app.post("/f/:siteId/:form", async (c) => {
    const siteId = c.req.param("siteId");
    const form = c.req.param("form").slice(0, 64);
    const site = store.getSite(siteId);
    if (!site) return c.text("Unknown site.", 404);

    const limit = limiter.check(`${siteId}:${addressOf(c)}`);
    if (!limit.allowed) {
      return c.text("Too many submissions. Try again shortly.", 429, {
        "retry-after": String(limit.retryAfterSeconds),
      });
    }

    // A contact form is not a file upload endpoint.
    const raw = await readLimited(c.req.raw, MAX_SUBMISSION_BYTES);
    if (!raw) return c.text("That submission is too large.", 413);

    const body = await new Response(raw, {
      headers: { "content-type": c.req.header("content-type") ?? "" },
    }).formData();
    const fields: Record<string, string> = {};
    let count = 0;
    for (const [name, value] of body.entries()) {
      if (typeof value !== "string") continue;
      count += 1;
      if (count > MAX_SUBMISSION_FIELDS) {
        return c.text("That submission has too many fields.", 413);
      }
      const key = name.slice(0, 64);
      const text = value.slice(0, 10_000);
      // A checkbox group sends one name several times; every ticked box is kept.
      fields[key] = key in fields ? `${fields[key]}, ${text}`.slice(0, 10_000) : text;
    }

    const budget = siteSubmissions.check(siteId);
    if (!budget.allowed) {
      return c.text("This site is receiving too many submissions. Try again later.", 429, {
        "retry-after": String(budget.retryAfterSeconds),
      });
    }

    const spam = assessSpam(fields);
    const data = contentFields(fields);
    store.addSubmission({
      siteId,
      form,
      data,
      spamScore: spam.score,
      spamReasons: spam.reasons,
    });

    if (options.notifier && spam.score < SPAM_THRESHOLD && notifications.check(siteId).allowed) {
      // Not awaited: the visitor should not wait on an email provider.
      void options.notifier.notify({
        kind: "submission",
        subject: `${site.name}: new ${form} submission`,
        lines: Object.entries(data).map(([key, value]) => `${key}: ${value}`),
      });
    }

    // Send the visitor somewhere sensible with no JavaScript involved.
    const redirect = fields._redirect;
    if (redirect && isSafeRedirect(redirect)) {
      // The path belongs to the site the form was on, not to the studio.
      const from = submittingOrigin(c.req.raw);
      return c.redirect(from ? new URL(redirect, from).href : redirect, 303);
    }
    return c.html(thanksPage(), 200);
  });

  /** Who a signed session belongs to now: null once an editor is removed or their password changes. */
  const viewerOf = (session: Session | null): Viewer | null => {
    if (!session || store.isSessionRevoked(session.id)) return null;
    if (session.actor === "studio") return { name: "studio", owner: true };
    const editor = store.getEditor(Number(session.actor.slice("editor:".length)));
    if (!editor || session.stamp !== editorStamp(signingKey, editor.passwordHash)) return null;
    return { name: editor.name, email: editor.email, owner: false };
  };
  const stampFor = (actor: string) => {
    if (actor === "studio") return "-";
    const editor = store.getEditor(Number(actor.slice("editor:".length)));
    return editor ? editorStamp(signingKey, editor.passwordHash) : "-";
  };
  /** The studio's own session, plus the preview's cookie when the preview lives on a sibling host. */
  const signIn = (c: Context, actor: string) => {
    const secure = isSecure(c);
    const stamp = stampFor(actor);
    c.header("Set-Cookie", createSessionCookie(signingKey, { actor, stamp, secure }));
    if (options.cookieDomain) {
      c.header(
        "Set-Cookie",
        createPreviewCookie(signingKey, { actor, stamp, secure, domain: options.cookieDomain }),
        { append: true },
      );
    }
  };
  const signOut = (c: Context) => {
    // Clearing the cookie is the browser's part; a copy of it must stop working as well.
    const cookies = c.req.header("cookie");
    for (const session of [
      readSession(cookies, signingKey),
      readPreviewSession(cookies, signingKey),
    ]) {
      if (session) store.revokeSession(session.id, session.expiresAt);
    }
    c.header("Set-Cookie", clearSessionCookie(isSecure(c)));
    if (options.cookieDomain) {
      c.header("Set-Cookie", clearPreviewCookie(isSecure(c), options.cookieDomain), {
        append: true,
      });
    }
  };

  // Before sign-in, so the sign-in page is drawn in the theme the visitor chose too.
  app.use("*", (c, next) => withTheme(themeOf(c.req.header("cookie")), next));

  app.use("*", async (c, next) => {
    // The decoded path, exactly as the router matches it.
    const path = c.req.path;
    // Managed sites post submissions from their own domains, so this one route is exempt.
    if (path.startsWith("/f/")) return next();

    if (c.req.method !== "GET" && !isSameOrigin(c.req.raw)) {
      return c.text("Cross-origin form posts are refused.", 403);
    }

    const url = new URL(c.req.url);
    // The sign-in page needs the stylesheet, and the assets are this app's own code, not data.
    if (
      path === "/sign-in" ||
      path === "/theme" ||
      path === "/auth/check" ||
      path === "/share" ||
      path.startsWith("/assets/") ||
      Object.hasOwn(ICONS, path.slice(1))
    ) {
      return next();
    }

    const session = readSession(c.req.header("cookie"), signingKey);
    if (!session) {
      if (c.req.method !== "GET")
        return c.text("Your session expired. Sign in and try again.", 401);
      const wanted = path === "/" ? "" : `?next=${encodeURIComponent(path + url.search)}`;
      return c.redirect(`/sign-in${wanted}`, 303);
    }
    const who = viewerOf(session);
    if (!who) {
      // Removed, or their password changed, since signing in: the cookie is signed, but no longer theirs.
      signOut(c);
      return c.redirect("/sign-in", 303);
    }
    c.set("actor", who.name);
    c.set("viewer", who);
    c.set("session", session.actor);
    const shell = { ...panesOf(c.req.header("cookie")), unread: () => store.countUnread() };
    return withViewer(who, () => withChrome(shell, next));
  });

  /** A plain form post, so the switch works before any script has loaded, or without one. */
  app.post("/theme", async (c) => {
    const form = await c.req.formData();
    const chosen = String(form.get("theme") ?? "");
    const value = (THEMES as readonly string[]).includes(chosen) ? chosen : "system";
    c.header(
      "set-cookie",
      `${THEME_COOKIE}=${value}; Path=/; SameSite=Lax; Max-Age=31536000${isSecure(c) ? "; Secure" : ""}`,
    );
    // Back to the screen the switch was on: a path on this studio, never anywhere else.
    let back = "/";
    try {
      const from = new URL(c.req.header("referer") ?? "");
      if (from.host === new URL(c.req.url).host) back = from.pathname + from.search;
    } catch {
      // No referrer: the sites list is as good a place as any.
    }
    return c.redirect(isSafeRedirect(back) ? back : "/", 303);
  });

  // Sites and people are the owner's to change; editors change content. Attached to the
  // routes through the router, so no spelling of a path reaches one without passing here.
  const ownerOnly: MiddlewareHandler = async (c, next) => {
    if (c.get("viewer")?.owner) return next();
    return c.html(errorPage("Only the owner can do that", "Ask whoever runs this studio."), 403);
  };
  for (const route of [
    "/sites",
    "/sites/new",
    "/sites/:id/settings",
    "/sites/:id/delete",
    "/editors",
    "/editors/*",
  ]) {
    app.use(route, ownerOnly);
  }

  /**
   * Where to send someone after signing in: a page of this studio, or a sibling host
   * under the same domain, such as the preview the proxy asked us to vouch for.
   * Anything else is an open redirect, and becomes the home page.
   */
  const allowedNext = (value: unknown): string | null => {
    if (typeof value !== "string" || value === "" || /[\\\s]/.test(value)) return null;
    if (value.startsWith("/")) {
      // Parsed against a throwaway origin: a path that resolves elsewhere (`//host`, `/\\host`) is not a path.
      const resolved = new URL(value, "http://next.invalid");
      if (resolved.origin !== "http://next.invalid") return null;
      return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    }
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      return null;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    const host = target.hostname;
    if (options.cookieDomain) {
      const parent = options.cookieDomain.replace(/^\./, "");
      return host === parent || host.endsWith(`.${parent}`) ? target.href : null;
    }
    const own = options.publicUrl ? new URL(options.publicUrl).hostname : null;
    return own && host === own ? target.href : null;
  };

  /**
   * For a reverse proxy's forward-auth: 204 when the browser asking is signed in here,
   * otherwise a redirect to sign in that comes back to the page it wanted. Caddy's
   * `forward_auth` sends the original request's host and path in these headers.
   */
  /** A share token is good for the preview host of the site it names, and no other. */
  const shareFits = (token: string | undefined, host: string | undefined) => {
    const siteId = readShareToken(token, signingKey);
    const site = siteId ? store.getSite(siteId) : null;
    if (!site?.devUrl || !host) return false;
    try {
      return new URL(site.devUrl).host === host;
    } catch {
      return false;
    }
  };

  app.get("/auth/check", (c) => {
    const cookies = c.req.header("cookie");
    if (
      viewerOf(readPreviewSession(cookies, signingKey)) ||
      viewerOf(readSession(cookies, signingKey))
    ) {
      return c.body(null, 204);
    }
    const host = c.req.header("x-forwarded-host");
    if (shareFits(readShareCookie(c.req.header("cookie")), host)) return c.body(null, 204);
    // A share link: trade the token for a cookie at the studio, which can set one for the whole domain.
    const uri = c.req.header("x-forwarded-uri") ?? "/";
    const token =
      new URL(uri, "http://preview.invalid").searchParams.get("greatcms-share") ?? undefined;
    if (token && options.publicUrl && shareFits(token, host)) {
      const clean = new URL(uri, "http://preview.invalid");
      clean.searchParams.delete("greatcms-share");
      const back = allowedNext(
        `${c.req.header("x-forwarded-proto") === "http" ? "http" : "https"}://${host}${clean.pathname}${clean.search}`,
      );
      if (back) {
        return c.redirect(
          `${options.publicUrl}/share?token=${encodeURIComponent(token)}&next=${encodeURIComponent(back)}`,
          302,
        );
      }
    }
    const wanted =
      host && options.publicUrl
        ? allowedNext(
            `${c.req.header("x-forwarded-proto") === "http" ? "http" : "https"}://${host}${c.req.header("x-forwarded-uri") ?? "/"}`,
          )
        : null;
    if (!wanted) return c.text("Sign in to the studio first.", 401);
    return c.redirect(`${options.publicUrl}/sign-in?next=${encodeURIComponent(wanted)}`, 302);
  });

  app.get("/share", (c) => {
    const token = c.req.query("token");
    const next = allowedNext(c.req.query("next"));
    const siteId = readShareToken(token, signingKey);
    if (!token || !siteId || !next || next.startsWith("/")) {
      return c.html(
        errorPage("Preview link", "This preview link has expired or is not valid."),
        403,
      );
    }
    c.header("Set-Cookie", shareCookie(token, isSecure(c), options.cookieDomain));
    return c.redirect(next, 302);
  });

  app.post("/sites/:id/share", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    if (!site.devUrl)
      return c.html(errorPage(site.name, "Add the site's preview address first."), 422);
    const path = String((await c.req.formData()).get("path") ?? "/");
    const preview = new URL(site.devUrl);
    let url = new URL(path.startsWith("/") ? path : "/", preview);
    // `//elsewhere` is a path to another host: the token would travel with it.
    if (url.origin !== preview.origin) url = new URL("/", preview);
    url.searchParams.set("greatcms-share", createShareToken(signingKey, site.id));
    return c.html(sharePage({ site, url: url.href }));
  });

  app.get("/:file{favicon\\.ico|favicon\\.svg|apple-touch-icon\\.png}", (c) => {
    const found = icon(c.req.param("file"));
    if (!found) return c.notFound();
    return c.body(new Uint8Array(found.body), 200, {
      "content-type": found.type,
      "cache-control": "public, max-age=86400",
    });
  });

  /** The stylesheet and the client bundles. A URL carrying the content's hash may be cached for good. */
  app.get("/assets/:file", async (c) => {
    const found = asset(c.req.param("file"));
    if (!found) return c.notFound();

    // A font's name changes whenever its bytes do, so it is pinned without a version in the URL.
    const file = c.req.param("file");
    const pinned = c.req.query("v") === found.version || found.type.startsWith("font/");
    const headers: Record<string, string> = {
      "content-type": typeof found.body === "string" ? `${found.type}; charset=utf-8` : found.type,
      "cache-control": pinned ? "public, max-age=31536000, immutable" : "public, max-age=300",
      etag: `"${found.version}"`,
      vary: "accept-encoding",
    };
    if (c.req.header("if-none-match")?.includes(found.version)) return c.body(null, 304, headers);
    const packed = compressed(file, found, c.req.header("accept-encoding"));
    if (packed) {
      return c.body(new Uint8Array(packed.body), 200, {
        ...headers,
        "content-encoding": packed.encoding,
      });
    }
    return c.body(found.body, 200, headers);
  });

  const hasEditors = () => store.listEditors().length > 0;

  /** Records that the signed-in person has this content open, and says who else does. */
  const here = (c: { get(key: "viewer"): Viewer }, siteId: string, path: string) => {
    const who = c.get("viewer");
    return store.presence({ siteId, path, actor: who.email ?? "owner", name: who.name });
  };

  app.get("/sign-in", (c) => {
    const next = allowedNext(c.req.query("next")) ?? undefined;
    // Signed in here already, sent from the preview: renew its cookie rather than ask again.
    const session = readSession(c.req.header("cookie"), signingKey);
    if (next && viewerOf(session)) {
      signIn(c, session!.actor);
      return c.redirect(next, 303);
    }
    return c.html(signInPage({ next, editors: hasEditors() }));
  });

  app.get("/editors", (c) => c.html(editorsPage({ editors: store.listEditors() })));

  app.post("/editors", async (c) => {
    const form = await c.req.formData();
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const chosen = String(form.get("password") ?? "");
    const problem = !name
      ? "Give the editor a name; it is what their commits will say."
      : !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
        ? "That email address does not look complete."
        : chosen.length < 12
          ? "Use a password of at least 12 characters."
          : store.findEditor(email)
            ? "Someone with that email can already sign in."
            : null;
    if (problem) {
      return c.html(
        editorsPage({
          editors: store.listEditors(),
          flash: { kind: "error", message: problem },
          values: { name, email },
        }),
        422,
      );
    }
    store.addEditor({ name, email, passwordHash: hashPassword(chosen) });
    return c.html(
      editorsPage({
        editors: store.listEditors(),
        flash: { kind: "success", message: `${name} can sign in with ${email}.` },
      }),
    );
  });

  app.post("/editors/:id/password", async (c) => {
    const editor = store.getEditor(Number(c.req.param("id")));
    if (!editor) return c.notFound();
    const chosen = String((await c.req.formData()).get("password") ?? "");
    if (chosen.length < 12) {
      return c.html(
        editorsPage({
          editors: store.listEditors(),
          flash: { kind: "error", message: "Use a password of at least 12 characters." },
        }),
        422,
      );
    }
    store.setEditorPassword(editor.id, hashPassword(chosen));
    return c.html(
      editorsPage({
        editors: store.listEditors(),
        flash: { kind: "success", message: `${editor.name}'s password is changed.` },
      }),
    );
  });

  app.post("/editors/:id/delete", (c) => {
    const editor = store.getEditor(Number(c.req.param("id")));
    if (editor) store.removeEditor(editor.id);
    return c.redirect("/editors", 303);
  });

  app.post("/sign-in", async (c) => {
    // One password guards everything here, so guessing has to cost something.
    const address = addressOf(c);
    const limit = signInLimiter.check(`sign-in:${address}`);
    if (!limit.allowed) {
      return c.html(
        signInPage({
          error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
        }),
        429,
        { "retry-after": String(limit.retryAfterSeconds) },
      );
    }

    const raw = await readLimited(c.req.raw, MAX_SIGN_IN_BYTES);
    if (!raw) return c.html(signInPage({ error: "That request was too large." }), 413);
    const form = await new Response(raw, {
      headers: { "content-type": c.req.header("content-type") ?? "" },
    }).formData();
    const supplied = String(form.get("password") ?? "");
    const email = String(form.get("email") ?? "").trim();
    const next = allowedNext(form.get("next")) ?? undefined;
    let actor: string | null = null;
    if (email) {
      const editor = store.findEditor(email);
      // Hash even for an unknown address, so the answer takes as long either way.
      const ok = verifyPassword(supplied, editor?.passwordHash ?? DUMMY_HASH);
      if (editor && ok) actor = `editor:${editor.id}`;
    } else if (checkPassword(supplied, password)) {
      actor = "studio";
    }
    if (!actor) {
      // Deliberately vague, and the same shape whether or not a password was supplied: there is nothing to learn from it.
      return c.html(
        signInPage({ error: "That did not work.", next, email, editors: hasEditors() }),
        401,
      );
    }

    signInLimiter.clear(`sign-in:${address}`);
    signIn(c, actor);
    const sites = store.listSites();
    const only = sites.length === 1 ? `/sites/${sites[0]!.id}` : "/";
    return c.redirect(next ?? only, 303);
  });

  app.post("/sign-out", (c) => {
    signOut(c);
    return c.redirect("/sign-in", 303);
  });

  app.get("/", async (c) => {
    const sites = store.listSites();
    return c.html(sitesPage(sites, store.countUnread(), undefined, await liveness.all(sites)));
  });

  app.get("/inbox", (c) => {
    const siteId = c.req.query("site") || undefined;
    const includeSpam = c.req.query("spam") === "1";
    return c.html(
      inboxPage({
        submissions: store.listSubmissions({ siteId, includeSpam }),
        sites: store.listSites(),
        siteId,
        includeSpam,
      }),
    );
  });

  app.get("/inbox.csv", (c) => {
    const siteId = c.req.query("site") || undefined;
    const rows = store.listSubmissions({ siteId, includeSpam: false, limit: 5000 });
    return c.body(toCsv(rows), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="submissions.csv"',
    });
  });

  app.post("/inbox/:id/read", async (c) => {
    const id = submissionId(c.req.param("id"));
    if (id === null) return c.notFound();
    const form = await c.req.formData();
    store.markRead(id, String(form.get("read") ?? "1") === "1");
    return c.redirect("/inbox", 303);
  });

  app.post("/inbox/:id/delete", (c) => {
    const id = submissionId(c.req.param("id"));
    if (id === null) return c.notFound();
    store.deleteSubmission(id);
    return c.redirect("/inbox", 303);
  });

  app.get("/sites/new", (c) => c.html(newSitePage()));

  app.post("/sites", async (c) => {
    const form = await c.req.formData();
    const values = {
      name: String(form.get("name") ?? "").trim(),
      path: String(form.get("path") ?? "").trim(),
      devUrl: String(form.get("devUrl") ?? "").trim(),
    };

    // A dev server is reached over HTTP. Anything else here ends up as an
    // iframe src on the editor page, where `javascript:` would run as us.
    if (values.devUrl && !isHttpUrl(values.devUrl)) {
      return c.html(
        newSitePage({
          error: "Nothing was connected: check the dev server URL.",
          fieldErrors: { devUrl: DEV_URL_ERROR },
          values,
        }),
        422,
      );
    }

    if (values.path && !(await isDirectory(values.path))) {
      return c.html(
        newSitePage({
          error: "Nothing was connected: check the folder path.",
          fieldErrors: { path: "There is no folder at this path on this machine." },
          values,
        }),
        422,
      );
    }

    if (!values.name || !values.path) {
      return c.html(
        newSitePage({ error: "A name and the folder's path are required.", values }),
        422,
      );
    }

    const candidate: Site = {
      id: crypto.randomUUID(),
      ...values,
      pushAfterPublish: false,
      deployRoot: "",
      createdAt: new Date().toISOString(),
    };

    // Verify before storing: a site that cannot be read is not connected, and finding.
    try {
      await new SiteClient(candidate).context();
    } catch (error) {
      return c.html(newSitePage({ error: describeError(error), values }), 422);
    }

    store.addSite(candidate);
    return c.redirect(`/sites/${candidate.id}`, 303);
  });

  app.get("/sites/:id/settings", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    // A schema that no longer parses is exactly when settings matter: the page still opens.
    const schema = await new SiteClient(site)
      .context()
      .then((context) => context.schema)
      .catch(() => undefined);
    return c.html(newSitePage({ editing: site, schema }));
  });

  app.post("/sites/:id/settings", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const form = await c.req.formData();
    const values = {
      name: String(form.get("name") ?? "").trim(),
      path: site.path,
      devUrl: String(form.get("devUrl") ?? "").trim(),
      deployRoot: String(form.get("deployRoot") ?? "").trim(),
    };
    if (values.deployRoot && !values.deployRoot.startsWith("/")) {
      return c.html(
        newSitePage({
          editing: site,
          values,
          error: "Nothing was saved: check the builder folder.",
          fieldErrors: { deployRoot: "Give the absolute path, such as /srv/www." },
        }),
        422,
      );
    }
    if (values.devUrl && !isHttpUrl(values.devUrl)) {
      return c.html(
        newSitePage({
          editing: site,
          values,
          error: "Nothing was saved: check the dev server URL.",
          fieldErrors: { devUrl: DEV_URL_ERROR },
        }),
        422,
      );
    }
    if (!values.name) {
      return c.html(newSitePage({ editing: site, values, error: "The site needs a name." }), 422);
    }
    store.updateSite(site.id, {
      name: values.name,
      devUrl: values.devUrl,
      pushAfterPublish: form.get("pushAfterPublish") === "on",
      deployRoot: values.deployRoot,
    });
    return c.redirect(`/sites/${site.id}`, 303);
  });

  /**
   * "Publish later": the form is kept as submitted, and replayed through the ordinary publish
   * when it falls due, so validation, the conflict check and authorship are the same as now.
   */
  const timeZone = options.timeZone ?? studioTimeZone();
  for (const base of ["/sites/:id/regions/:regionId", "/sites/:id/collections/:name/:slug"]) {
    app.post(base, async (c, next) => {
      const form = await c.req.formData();
      if (form.get("action") !== "schedule") return next();
      const site = store.getSite(c.req.param("id") ?? "");
      const target = contentOf(c);
      if (!site || !target || target.collection?.slug === "new") return c.notFound();
      const back = `/sites/${site.id}/${target.back}`;
      const dueAt = zonedToEpoch(String(form.get("publishAt") ?? ""), timeZone);
      const refuse = (message: string) =>
        c.html(
          page(
            { title: "Not scheduled", flash: { kind: "error", message } },
            html`<p><a class="button secondary" href="${back}">Back to the editor</a></p>`,
          ),
          422,
        );
      if (dueAt === null || dueAt < Date.now() + 60_000) {
        return refuse("Pick a time at least a minute from now.");
      }
      const entries: Array<[string, string]> = [];
      for (const [key, value] of form.entries()) {
        if (typeof value !== "string") {
          if (value.size > 0) {
            return refuse("New images cannot wait: publish them now, or schedule without them.");
          }
          continue;
        }
        if (key !== "action" && key !== "publishAt") entries.push([key, value]);
      }
      const who = c.get("viewer");
      store.schedule({
        siteId: site.id,
        target: target.back,
        label: target.regionId ?? `${target.collection!.name}/${target.collection!.slug}`,
        form: entries,
        dueAt,
        actor: c.get("session"),
        author: authorOf(who) ?? null,
      });
      return c.redirect(`/sites/${site.id}#scheduled`, 303);
    });
  }

  app.post("/sites/:id/scheduled/:job/cancel", (c) => {
    const job = store.getScheduled(Number(c.req.param("job")));
    if (!job || job.siteId !== c.req.param("id")) return c.notFound();
    store.settleScheduled(job.id, "cancelled", `cancelled by ${c.get("actor")}`);
    return c.redirect(`/sites/${job.siteId}#scheduled`, 303);
  });

  app.get("/sites/:id/search", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const query = (c.req.query("q") ?? "").slice(0, 120);
    const client = new SiteClient(site);
    const context = await client.context();
    return c.html(
      searchPage({
        site,
        schema: context.schema,
        query,
        hits: await searchSite(client, context, site.id, query),
      }),
    );
  });

  app.post("/sites/:id/rollback", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const sha = String((await c.req.formData()).get("sha") ?? "");
    if (!(await requestRollback(site.deployRoot, sha))) {
      return c.html(errorPage(site.name, "There is no release of that commit to go back to."), 404);
    }
    return c.redirect(`/sites/${site.id}#live`, 303);
  });

  app.get("/sites/:id/pending-media/:token/:index", (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const index = c.req.param("index");
    if (!/^\d+$/.test(index)) return c.notFound();
    const file = store.pendingMediaFile(
      site.id,
      c.req.query("scope") ?? "",
      c.req.param("token"),
      Number(index),
    );
    if (!file) return c.notFound();
    const type = Object.entries(ALLOWED_TYPES).find(([, extension]) =>
      file.path.endsWith(`.${extension}`),
    )?.[0];
    if (!type) return c.notFound();
    c.header("Content-Type", type);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(file.content));
  });

  app.get("/sites/:id/media/:file", async (c) => {
    const site = store.getSite(c.req.param("id"));
    const file = c.req.param("file");
    const type = MEDIA_TYPES[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
    if (!site || !type || !/^[\w][\w.-]*$/.test(file)) return c.notFound();

    const client = new SiteClient(site);
    const bytes = await client.mediaFile(await client.context(), file).catch(() => null);
    if (!bytes) return c.notFound();
    c.header("Content-Type", type);
    c.header("Cache-Control", "private, no-cache");
    c.header("X-Content-Type-Options", "nosniff");
    // An SVG is a document that can carry script; opened directly, it must not run in the studio's origin.
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return c.body(new Uint8Array(bytes));
  });

  app.get("/sites/:id/icon", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const tile = siteTile(site.name, (await findSiteIcon(site.path)) ?? undefined);
    c.header("Content-Type", "image/svg+xml");
    // The sidebar shows it on every screen; a favicon changing shows within minutes.
    c.header("Cache-Control", "private, max-age=300");
    c.header("X-Content-Type-Options", "nosniff");
    // A site's own SVG is inside it: opened directly, nothing in it may run in the studio's origin.
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    );
    return c.body(tile);
  });

  /** Everything the site page shows, read in parallel; the flash says why it is being shown again. */
  async function renderSitePage(
    c: Context<{ Variables: Variables }>,
    site: Site,
    flash?: PageOptions["flash"],
  ) {
    const client = new SiteClient(site);
    const context = await client.context();
    const names = Object.keys(context.schema.collections);
    const [drafts, sync, live, running, activity, counts] = await Promise.all([
      client.listLiveDrafts(context),
      client.syncState(),
      readLive(site.deployRoot),
      liveness.running(site),
      client.activity(context),
      Promise.all(names.map((name) => client.entryCount(context, name))),
    ]);
    return sitePage({
      site,
      schema: context.schema,
      flash,
      drafts,
      formsEndpoint: `${publicOrigin(c)}/f/${encodeURIComponent(site.id)}`,
      sync,
      live,
      scheduled: { jobs: store.listScheduled(site.id), timeZone },
      running,
      activity,
      counts: Object.fromEntries(names.map((name, index) => [name, counts[index] ?? 0])),
    });
  }

  app.get("/sites/:id", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();

    try {
      return c.html(await renderSitePage(c, site));
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.post("/sites/:id/push", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const pushed = await new SiteClient(site).push();
    if (pushed.ok) return c.redirect(`/sites/${site.id}`, 303);

    try {
      return c.html(await renderSitePage(c, site, { kind: "error", message: pushed.reason }), 502);
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.post("/sites/:id/delete", (c) => {
    store.removeSite(c.req.param("id"));
    return c.redirect("/", 303);
  });

  /** Collections are edited with the same generated forms and the same validation as regions. */
  app.get("/sites/:id/collections/:name", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");

    try {
      const client = new SiteClient(site);
      const context = await client.context();
      const collection = context.schema.collections[name];
      if (!collection) return c.notFound();

      const [entries, drafts, activity] = await Promise.all([
        client.listEntries(context, name),
        client.listLiveDrafts(context),
        client.activity(context, 0),
      ]);
      const drafted = new Set(drafts.map((draft) => draft.target));
      return c.html(
        collectionPage({
          site,
          schema: context.schema,
          name,
          label: collection.label ?? name,
          entryLabel: collection.entryLabel,
          entries: entries.map((entry) => ({
            slug: entry.slug,
            title: entryTitle(collection, entry.data, entry.slug),
            summary: (entry.data.summary ?? entry.data.description) as string | undefined,
            draft: drafted.has(`collections/${name}/${encodeURIComponent(entry.slug)}`),
            edited: activity.edited.get(`collections/${name}/${encodeURIComponent(entry.slug)}`),
          })),
        }),
      );
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.get("/sites/:id/collections/:name/:slug", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.notFound();

    try {
      const client = new SiteClient(site);
      const context = await client.context();
      const collection = context.schema.collections[name];
      if (!collection) return c.notFound();

      const entry = slug === "new" ? null : await client.readEntry(context, name, slug);
      if (slug !== "new" && !entry) return c.notFound();
      const draft = entry
        ? await client.readLiveDraft({ context, collection: { name, slug: entry.slug } })
        : null;
      const base =
        draft && entry
          ? await client.liveDraftBase({ context, collection: { name, slug: entry.slug } })
          : null;
      const data = draft ?? entry?.data;

      return c.html(
        editEntryPage({
          site,
          running: await liveness.running(site),
          schema: context.schema,
          name,
          label: collection.label ?? name,
          entryLabel: collection.entryLabel,
          titleField: collection.slug,
          slug: entry?.slug ?? null,
          fields: collection.fields,
          format: collection.format,
          body: collection.body,
          blocks: context.schema.blocks,
          document: client.entryDocument(context, name, data ? { ...entry!, data } : null),
          draft: draft !== null,
          staleDraft: base?.stale,
          others: entry ? here(c, site.id, `collections/${name}/${entry.slug}`) : [],
          previewUrl: entryPreview(site, context.config, name, entry?.slug ?? null),
          errors: new Map(),
          headSha: base?.base ?? context.headSha,
          mediaPreviews: committedPreviews(site.id, context.config, data),
          media: await client.mediaChoices(context),
          entries: await client.referenceChoices(context),
          elsewhere: await regionsElsewhere(client, context, site.id),
        }),
      );
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.post("/sites/:id/collections/:name/:slug/delete", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.notFound();

    try {
      const client = new SiteClient(site);
      const context = await client.context();
      const entry = await client.readEntry(context, name, slug);
      if (!entry) return c.notFound();

      await client.deleteEntry({
        context,
        name,
        slug,
        actor: c.get("actor"),
        author: authorOf(c.get("viewer")),
      });
      return c.redirect(`/sites/${site.id}/collections/${name}`, 303);
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.post("/sites/:id/collections/:name/:slug", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");
    const requested = c.req.param("slug");
    if (!isSafeSlug(requested)) return c.notFound();
    const actor = c.get("actor");

    const client = new SiteClient(site);
    let context: SiteContext;
    try {
      context = await client.context();
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }

    const collection = context.schema.collections[name];
    if (!collection) return c.notFound();

    const form = await c.req.formData();
    const entries: Array<[string, string]> = [...form.entries()].map(
      ([key, value]) => [key, typeof value === "string" ? value : ""] as [string, string],
    );
    const headSha = String(form.get("headSha") ?? "");
    const action = String(form.get("action") ?? "publish");

    const mediaScope = `collection:${name}:${requested}`;
    let pendingToken = String(form.get("pendingMedia") ?? "");
    type EntryView = Omit<Parameters<typeof editEntryPage>[0], keyof typeof fixed>;
    const fixed = {
      site,
      running: await liveness.running(site),
      schema: context.schema,
      name,
      label: collection.label ?? name,
      entryLabel: collection.entryLabel,
      titleField: collection.slug,
      fields: collection.fields,
      format: collection.format,
      body: collection.body,
      blocks: context.schema.blocks,
      previewUrl: entryPreview(site, context.config, name, requested === "new" ? null : requested),
    };
    const renderEntry = (view: EntryView) =>
      editEntryPage({
        ...fixed,
        ...view,
        pendingMedia: pendingToken,
        mediaPreviews: {
          ...committedPreviews(site.id, context.config, view.document),
          ...pendingPreviews(site.id, mediaScope, pendingToken, media),
        },
      });
    let media: UploadResult[] = [];
    try {
      const retained = await retainedMedia(
        store,
        site.id,
        mediaScope,
        form,
        entries,
        context.config,
      );
      media = retained.files;
      pendingToken = retained.token;
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      // A token that expired would fail every later post too, so the form stops carrying it.
      if (error instanceof ExpiredMediaError) pendingToken = "";
      return c.html(
        renderEntry({
          slug: requested === "new" ? null : requested,
          document: decodeForm(
            entries,
            collection.fields,
            blockFieldsOf(context),
            mdxBody(collection),
          ),
          errors: new Map(),
          headSha,
          flash: { kind: "error", message: error.message },
        }),
        422,
      );
    }

    const document = await keepMdxSource(
      c.get("viewer"),
      client,
      context,
      name,
      requested,
      decodeForm(entries, collection.fields, blockFieldsOf(context), mdxBody(collection)),
    );

    if (action.startsWith("nested:")) {
      const updated = applyNestedBlockAction(context.schema, collection, document, action, form);
      // The preview shows the draft, so a reordered or added section has to land there too.
      if (updated.changed && requested !== "new") {
        await client.writeLiveDraft({
          context,
          collection: { name, slug: requested },
          document,
          base: baseOf(entries),
        });
      }
      return c.html(
        renderEntry({
          slug: requested === "new" ? null : requested,
          document,
          errors: new Map(),
          headSha,
          openNested: updated.open,
          flash: updated.changed
            ? { kind: "success", message: "Section updated. Publish to save it." }
            : { kind: "error", message: "That section could not be updated." },
        }),
        updated.changed ? 200 : 422,
      );
    }

    const validation = validateFields(collection.fields, document, {
      strict: false,
      blocks: context.schema.blocks,
    });
    if (!validation.ok) {
      return c.html(
        renderEntry({
          slug: requested === "new" ? null : requested,
          document,
          errors: errorsByPath(validation.issues),
          headSha,
          flash: {
            kind: "error",
            message: "Nothing was published: this entry is not valid yet.",
            detail: validation.issues.map((issue) => issue.toString()),
          },
        }),
        422,
      );
    }

    // A new entry takes its file name from the slug field; an existing one keeps the name it has.
    const slug = requested === "new" ? client.entrySlug(context, name, document) : requested;
    if (requested === "new") {
      // "new" is the create route, so an entry stored under it could never be opened again.
      const taken = slug === "new" || (await client.readEntry(context, name, slug)) !== null;
      if (taken) {
        const field = collection.slug ?? "title";
        return c.html(
          renderEntry({
            slug: null,
            document,
            errors: new Map([
              [field, `An entry named “${slug}” already exists. Choose a different ${field}.`],
            ]),
            headSha,
            flash: {
              kind: "error",
              message: `Nothing was published: “${slug}” is already taken.`,
            },
          }),
          409,
        );
      }
    }

    try {
      const result = await client.publishEntry({
        context,
        name,
        slug,
        document,
        actor,
        author: authorOf(c.get("viewer")),
        expectedHeadSha: requested === "new" ? undefined : headSha || undefined,
        media: referencedMedia(media, document),
      });

      // The published file is now the truth; a leftover draft would keep the dev server showing the old edit.
      await client.clearLiveDraft({ context, collection: { name, slug } });
      if (pendingToken) store.clearPendingMedia(site.id, mediaScope, pendingToken);
      pendingToken = "";

      store.recordPublish({
        siteId: site.id,
        regionId: `${name}/${slug}`,
        commitSha: result.commitSha,
        commitUrl: result.url,
        actor,
      });
      void options.notifier?.notify({
        kind: "publish",
        subject: `${site.name}: ${actor} published ${name}/${slug}`,
        lines: [`commit ${result.commitSha.slice(0, 7)}`],
      });

      return c.html(
        renderEntry({
          slug,
          document,
          errors: new Map(),
          headSha: result.commitSha,
          flash: await publishedFlash(site, client, result.commitSha),
        }),
      );
    } catch (error) {
      return c.html(
        renderEntry({
          slug: requested === "new" ? null : slug,
          document,
          errors: new Map(),
          headSha,
          flash: { kind: "error", message: describeError(error) },
        }),
        error instanceof ConflictError ? 409 : 502,
      );
    }
  });

  /** An unsaved edit, written where the site's dev server will read it. */
  app.post("/sites/:id/regions/:regionId/draft", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const regionId = c.req.param("regionId");

    const client = new SiteClient(site);
    const context = await client.context();
    const region = context.schema.regions[regionId];
    if (!region) return c.notFound();

    const entries = await formEntries(c.req.raw);
    const document = isBlocksRegion(region)
      ? { blocks: decodeBlocks(entries, (type) => context.schema.blocks[type]?.fields) }
      : decodeForm(entries, region.fields, blockFieldsOf(context));

    here(c, site.id, `regions/${regionId}`);
    const written = await client.writeLiveDraft({
      context,
      regionId,
      document,
      base: baseOf(entries),
    });
    return c.body(null, written ? 204 : 409);
  });

  /** Throws the unsaved edit away, so the site goes back to what is published. */
  app.post("/sites/:id/regions/:regionId/draft/discard", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const regionId = c.req.param("regionId");

    const client = new SiteClient(site);
    await client.clearLiveDraft({ context: await client.context(), regionId });
    return c.redirect(`/sites/${site.id}/regions/${regionId}`, 303);
  });

  app.post("/sites/:id/collections/:name/:slug/draft/discard", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.notFound();

    const client = new SiteClient(site);
    await client.clearLiveDraft({ context: await client.context(), collection: { name, slug } });
    return c.redirect(`/sites/${site.id}/collections/${name}/${encodeURIComponent(slug)}`, 303);
  });

  app.post("/sites/:id/collections/:name/:slug/draft", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.notFound();

    const client = new SiteClient(site);
    const context = await client.context();
    const collection = context.schema.collections[name];
    if (!collection || slug === "new") return c.notFound();

    const entries = await formEntries(c.req.raw);
    const document = await keepMdxSource(
      c.get("viewer"),
      client,
      context,
      name,
      slug,
      decodeForm(entries, collection.fields, blockFieldsOf(context), mdxBody(collection)),
    );
    here(c, site.id, `collections/${name}/${slug}`);
    const written = await client.writeLiveDraft({
      context,
      collection: { name, slug },
      document,
      base: baseOf(entries),
    });
    return c.body(null, written ? 204 : 409);
  });

  for (const base of ["/sites/:id/regions/:regionId", "/sites/:id/collections/:name/:slug"]) {
    app.get(`${base}/history`, async (c) => {
      const site = store.getSite(c.req.param("id") ?? "");
      const target = contentOf(c);
      if (!site || !target) return c.notFound();
      const client = new SiteClient(site);
      const context = await client.context();
      const label = target.regionId
        ? (context.schema.regions[target.regionId]?.label ?? target.regionId)
        : `${context.schema.collections[target.collection!.name]?.label ?? target.collection!.name}: ${target.collection!.slug}`;
      if (
        target.regionId
          ? !context.schema.regions[target.regionId]
          : !context.schema.collections[target.collection!.name]
      ) {
        return c.notFound();
      }
      return c.html(
        historyPage({
          site,
          schema: context.schema,
          label,
          back: `/sites/${site.id}/${target.back}`,
          entries: await client.contentHistory({ context, ...target }),
        }),
      );
    });

    app.post(`${base}/history/:sha/restore`, async (c) => {
      const site = store.getSite(c.req.param("id") ?? "");
      const target = contentOf(c);
      if (!site || !target) return c.notFound();
      const client = new SiteClient(site);
      const context = await client.context();
      const restored = await client.restoreToDraft({
        context,
        ...target,
        sha: c.req.param("sha") ?? "",
      });
      if (!restored) return c.html(errorPage(site.name, "That version could not be read."), 404);
      return c.redirect(`/sites/${site.id}/${target.back}`, 303);
    });
  }

  app.get("/sites/:id/regions/:regionId", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const regionId = c.req.param("regionId");

    try {
      const client = new SiteClient(site);
      const context = await client.context();
      const region = context.schema.regions[regionId];
      if (!region) return c.notFound();

      const draft = await client.readLiveDraft({ context, regionId });
      const document = draft
        ? (resolveRegion(context.schema, regionId, draft) ?? {})
        : await client.resolvedRegion(context, regionId);
      const base = draft ? await client.liveDraftBase({ context, regionId }) : null;
      return c.html(
        editRegionPage({
          site,
          running: await liveness.running(site),
          schema: context.schema,
          regionId,
          region,
          file: regionFilePath(context.config, regionId),
          document,
          draft: draft !== null,
          staleDraft: base?.stale,
          others: here(c, site.id, `regions/${regionId}`),
          previewUrl: regionPreview(site, context.config, regionId),
          errors: new Map(),
          headSha: base?.base ?? context.headSha,
          mediaPreviews: committedPreviews(site.id, context.config, document),
          media: await client.mediaChoices(context),
          entries: await client.referenceChoices(context),
          elsewhere: await regionsElsewhere(client, context, site.id, regionId),
        }),
      );
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.post("/sites/:id/regions/:regionId", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const regionId = c.req.param("regionId");
    const actor = c.get("actor");

    const client = new SiteClient(site);
    let context: SiteContext;
    try {
      context = await client.context();
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }

    const region = context.schema.regions[regionId];
    if (!region) return c.notFound();

    const form = await c.req.formData();
    const entries: Array<[string, string]> = [...form.entries()].map(
      ([key, value]) => [key, typeof value === "string" ? value : ""] as [string, string],
    );
    const action = String(form.get("action") ?? "publish");
    const headSha = String(form.get("headSha") ?? "");

    // Uploads ride along in the same form, keyed by the field they belong to.
    const mediaScope = `region:${regionId}`;
    let pendingToken = String(form.get("pendingMedia") ?? "");
    type RegionView = Omit<
      Parameters<typeof editRegionPage>[0],
      "site" | "schema" | "regionId" | "region"
    >;
    const running = await liveness.running(site);
    const renderRegion = (view: RegionView) =>
      editRegionPage({
        site,
        running,
        schema: context.schema,
        regionId,
        region,
        file: regionFilePath(context.config, regionId),
        previewUrl: regionPreview(site, context.config, regionId),
        ...view,
        pendingMedia: pendingToken,
        mediaPreviews: {
          ...committedPreviews(site.id, context.config, view.document),
          ...pendingPreviews(site.id, mediaScope, pendingToken, media),
        },
      });
    let media: UploadResult[] = [];
    try {
      const retained = await retainedMedia(
        store,
        site.id,
        mediaScope,
        form,
        entries,
        context.config,
      );
      media = retained.files;
      pendingToken = retained.token;
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      // A token that expired would fail every later post too, so the form stops carrying it.
      if (error instanceof ExpiredMediaError) pendingToken = "";
      return c.html(
        renderRegion({
          document: isBlocksRegion(region)
            ? { blocks: decodeBlocks(entries, (type) => context.schema.blocks[type]?.fields) }
            : decodeForm(entries, region.fields, blockFieldsOf(context)),
          errors: new Map(),
          headSha,
          flash: { kind: "error", message: error.message },
        }),
        422,
      );
    }

    const document: RegionDocument = isBlocksRegion(region)
      ? {
          blocks: decodeBlocks(entries, (type) => context.schema.blocks[type]?.fields),
        }
      : decodeForm(entries, region.fields, blockFieldsOf(context));

    if (action.startsWith("nested:")) {
      const updated = applyNestedBlockAction(context.schema, region, document, action, form);
      if (updated.changed) {
        await client.writeLiveDraft({ context, regionId, document, base: baseOf(entries) });
      }
      return c.html(
        renderRegion({
          document,
          errors: new Map(),
          headSha,
          openBlock: nestedParentBlock(action),
          openNested: updated.open,
          flash: updated.changed
            ? { kind: "success", message: "Section updated. Publish to save it." }
            : { kind: "error", message: "That section could not be updated." },
        }),
        updated.changed ? 200 : 422,
      );
    }

    // Block list edits round-trip through the server so add, remove, and reorder work without JavaScript.
    if (action !== "publish" && action !== "draft" && isBlocksRegion(region)) {
      const blocks = document.blocks as Array<Record<string, unknown>>;
      const updated = applyBlockAction(
        action,
        blocks,
        String(form.get("addType") ?? ""),
        region.allow,
      );
      if (updated.changed) {
        await client.writeLiveDraft({
          context,
          regionId,
          document: { blocks },
          base: baseOf(entries),
        });
      }
      return c.html(
        renderRegion({
          document: { blocks },
          errors: new Map(),
          headSha,
          openBlock: updated.open,
          flash: updated.changed
            ? { kind: "success", message: "Sections updated. Publish to save them." }
            : { kind: "error", message: "That section could not be updated." },
        }),
        updated.changed ? 200 : 422,
      );
    }

    const validation = validateRegion(context.schema, regionId, document, { strict: false });
    if (!validation.ok) {
      return c.html(
        renderRegion({
          document,
          errors: errorsByPath(validation.issues),
          headSha,
          flash: {
            kind: "error",
            message: "Nothing was published: this content is not valid yet.",
            detail: validation.issues.map((issue) => issue.toString()),
          },
        }),
        422,
      );
    }

    try {
      const result = await client.publishRegion({
        context,
        regionId,
        document,
        actor,
        author: authorOf(c.get("viewer")),
        expectedHeadSha: headSha || undefined,
        media: referencedMedia(media, document),
      });
      await client.clearLiveDraft({ context, regionId });
      if (pendingToken) store.clearPendingMedia(site.id, mediaScope, pendingToken);
      pendingToken = "";

      store.recordPublish({
        siteId: site.id,
        regionId,
        commitSha: result.commitSha,
        commitUrl: result.url,
        actor,
      });
      void options.notifier?.notify({
        kind: "publish",
        subject: `${site.name}: ${actor} published ${regionId}`,
        lines: [`commit ${result.commitSha.slice(0, 7)}`],
      });
      return c.html(
        renderRegion({
          document,
          errors: new Map(),
          headSha: result.commitSha,
          flash: await publishedFlash(site, client, result.commitSha),
        }),
      );
    } catch (error) {
      const conflict = error instanceof ConflictError;
      return c.html(
        renderRegion({
          document,
          errors: new Map(),
          // Keeping the old head means publishing again cannot overwrite what just changed.
          headSha,
          flash: { kind: "error", message: describeError(error) },
        }),
        conflict ? 409 : 502,
      );
    }
  });

  app.notFound((c) => c.html(errorPage("Not found", "That page does not exist."), 404));

  /** Publishes whatever has fallen due, each replayed as its author through the publish route. */
  const runDueSchedules = async (now = Date.now()) => {
    for (const job of store.dueScheduled(now)) {
      if (!store.claimScheduled(job.id)) continue;
      const body = new URLSearchParams(job.form);
      body.set("action", "publish");
      const cookie = createSessionCookie(signingKey, {
        actor: job.actor,
        stamp: stampFor(job.actor),
      }).split(";")[0] as string;
      // oxlint-disable-next-line no-await-in-loop -- one publish at a time, in the order they fell due
      const response = await app.request(`/sites/${job.siteId}/${job.target}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const outcome =
        response.status === 200
          ? null
          : response.status === 409
            ? "The content changed after it was scheduled, so it was not overwritten."
            : response.status === 422
              ? "It no longer passes validation; open it and publish by hand."
              : response.status === 303
                ? "The person who scheduled it can no longer sign in."
                : `The publish failed (${response.status}).`;
      store.settleScheduled(job.id, outcome ? "failed" : "published", outcome ?? undefined);
    }
  };

  return Object.assign(app, { runDueSchedules });
}

/** The field an MDX entry keeps as source: its JSX is not HTML, and sanitizing would delete it. */
function mdxBody(collection: CollectionDef): string | undefined {
  return collection.format === "mdx" ? collection.body : undefined;
}

/**
 * MDX is code the site's build runs, so only the owner changes it: whatever an editor posts for
 * the body, the stored source is what is kept.
 */
async function keepMdxSource(
  who: Viewer | undefined,
  client: SiteClient,
  context: SiteContext,
  name: string,
  slug: string,
  document: RegionDocument,
): Promise<RegionDocument> {
  const body = mdxBody(client.collection(context, name));
  if (!body || who?.owner) return document;
  const stored = slug === "new" ? null : await client.readEntry(context, name, slug);
  return { ...document, [body]: stored?.data[body] };
}

/** What the editor is told after a publish, pushing it first when the site asks for that. */
async function publishedFlash(
  site: Site,
  client: SiteClient,
  commitSha: string,
): Promise<{ kind: "success" | "error"; message: string }> {
  const published = `Published as ${commitSha.slice(0, 7)}`;
  if (!site.pushAfterPublish) {
    return { kind: "success", message: `${published}. Pushing it is what deploys it.` };
  }
  const pushed = await client.push();
  return pushed.ok
    ? {
        kind: "success",
        message: `${published} and pushed to ${pushed.upstream}. Your site rebuilds from there.`,
      }
    : {
        kind: "error",
        message: `${published} on this machine, but not pushed, so it is not live yet. ${pushed.reason}`,
      };
}

function thanksPage(): string {
  return page(
    { title: "Message received" },
    "<h1>Thank you</h1><p>Your message has been received.</p>",
  );
}

/** Resolves a block name to its fields, for nested `blocks` fields. */
function blockFieldsOf(context: SiteContext) {
  return (type: string) => context.schema.blocks[type]?.fields;
}

/** A region or an entry, from the URL, for the screens that work on either. */
function contentOf(c: { req: { param(name: string): string | undefined } }) {
  const regionId = c.req.param("regionId");
  // Shapes the schema allows, so a stored `back` can only ever lead to an editor.
  if (regionId)
    return REGION_ID_RE.test(regionId) ? { regionId, back: `regions/${regionId}` } : null;
  const name = c.req.param("name") ?? "";
  const slug = c.req.param("slug") ?? "";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || !isSafeSlug(slug)) return null;
  return { collection: { name, slug }, back: `collections/${name}/${encodeURIComponent(slug)}` };
}

/** Compared against when an unknown email signs in, so the reply takes the same time. */
const DUMMY_HASH = hashPassword(randomSecret());

/** The owner commits as git's configured identity; an editor commits as themselves. */
function authorOf(who: Viewer): Author | undefined {
  return who.owner || !who.email ? undefined : { name: who.name, email: who.email };
}

/** The commit the form was loaded at, which a draft remembers as where it began. */
function baseOf(entries: Array<[string, string]>): string | undefined {
  const sha = entries.find(([key]) => key === "headSha")?.[1];
  return sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** Where the preview should open for an entry: the page it is on, when the site's config says where that is. */
/** The page a region is seen on, from `preview.paths`, so its editor frames that page. */
function regionPreview(site: Site, config: CmsConfig, region: string): string | undefined {
  if (!site.devUrl) return undefined;
  const path = previewPath(config, { region });
  return path === "/" ? site.devUrl : onDevServer(site.devUrl, path);
}

/** A path resolved against the dev server, and the dev server itself if it would leave it. */
function onDevServer(devUrl: string, path: string): string {
  const url = new URL(path, devUrl);
  return url.origin === new URL(devUrl).origin ? url.href : devUrl;
}

function entryPreview(
  site: Site,
  config: CmsConfig,
  collection: string,
  slug: string | null,
): string | undefined {
  if (!site.devUrl) return undefined;
  if (!slug) return site.devUrl;
  return onDevServer(site.devUrl, previewPath(config, { collection, slug }));
}

function errorPage(title: string, message: string): string {
  return page(
    { title, flash: { kind: "error", message } },
    html`<p><a class="button secondary" href="/">Back to sites</a></p>`,
  );
}

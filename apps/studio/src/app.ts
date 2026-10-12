/** The studio's HTTP surface. */

import { stat } from "node:fs/promises";
import { regionsElsewhere } from "./elsewhere.js";
import {
  isBlocksRegion,
  isSafeSlug,
  type CollectionDef,
  type CmsConfig,
  type CmsSchema,
  type FieldDef,
  type RegionDef,
  type RegionDocument,
  validateFields,
  previewPath,
  resolveRegion,
  validateRegion,
} from "@greatcms/spec";
import { Hono } from "hono";
import { html } from "hono/html";
import { compress } from "hono/compress";
import {
  checkPassword,
  clearSessionCookie,
  createSessionCookie,
  isSameOrigin,
  readSession,
  sessionKey,
} from "./auth.js";
import type { Site, Store } from "./db.js";
import { decodeBlocks, decodeForm, fieldName, MEDIA_ROOT, parsePath } from "./form.js";
import { ALLOWED_TYPES, prepareUpload, UploadError, type UploadResult } from "./media.js";
import {
  assessSpam,
  contentFields,
  type Notifier,
  RateLimiter,
  SPAM_THRESHOLD,
  toCsv,
} from "./submissions.js";
import { SiteClient, type SiteContext } from "./sites.js";
import { ConflictError, type FileChange } from "./repo.js";
import { errorsByPath } from "./views/fields.js";
import { page } from "./views/layout.js";
import { asset, icon, ICONS } from "./assets.js";
import {
  collectionPage,
  editEntryPage,
  editRegionPage,
  inboxPage,
  newSitePage,
  signInPage,
  sitePage,
  sitesPage,
} from "./views/pages.js";

export interface AppOptions {
  store: Store;
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
  /** Submissions one site may store per day, whoever sends them. Injected by tests. */
  siteSubmissionLimiter?: RateLimiter;
  /** Notification emails one site may send per hour. Injected by tests. */
  notificationLimiter?: RateLimiter;
}

/** Bodies a public visitor can post, past which this is not a contact form. */
const MAX_SUBMISSION_BYTES = 64 * 1024;
/** A password form is a few hundred bytes; anything near this is not a sign-in. */
const MAX_SIGN_IN_BYTES = 4 * 1024;
/** What a committed upload can be previewed as: anything the studio accepts, plus SVG a developer committed. */
const MEDIA_TYPES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(ALLOWED_TYPES).map(([type, extension]) => [extension, type]),
  ),
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};
const MAX_SUBMISSION_FIELDS = 64;

type Variables = { actor: string };

export function createApp(options: AppOptions) {
  const { store, password, secret } = options;
  const app = new Hono<{ Variables: Variables }>();
  // Pages are small; the editor bundle is not, and a remote studio is often on a slow link.
  app.use("*", compress());

  const limiter = options.rateLimiter ?? new RateLimiter();
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
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    );
    c.res.headers.set("x-content-type-options", "nosniff");
    // `same-origin`, not `no-referrer`. With no-referrer Chrome sends
    // `Origin: null` on a same-origin form post, which the CSRF check above
    // refuses — every form in this app would break for anyone without
    // JavaScript. This keeps the referrer inside the studio and sends none to
    // anywhere else, which is the part that was actually worth having.
    c.res.headers.set("referrer-policy", "same-origin");
    // A studio is never a search result, and never a shared browser's history.
    c.res.headers.set("cache-control", "no-store");
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
      fields[name.slice(0, 64)] = value.slice(0, 10_000);
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

  app.use("*", async (c, next) => {
    // Managed sites post submissions from their own domains, so this one route is exempt.
    if (new URL(c.req.url).pathname.startsWith("/f/")) return next();

    if (c.req.method !== "GET" && !isSameOrigin(c.req.raw)) {
      return c.text("Cross-origin form posts are refused.", 403);
    }

    const url = new URL(c.req.url);
    const path = url.pathname;
    // The sign-in page needs the stylesheet, and the assets are this app's own code, not data.
    if (
      path === "/sign-in" ||
      path === "/auth/check" ||
      path.startsWith("/assets/") ||
      ICONS[path.slice(1)]
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
    c.set("actor", session.actor);
    return next();
  });

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
  app.get("/auth/check", (c) => {
    if (readSession(c.req.header("cookie"), signingKey)) return c.body(null, 204);
    const host = c.req.header("x-forwarded-host");
    const wanted =
      host && options.publicUrl
        ? allowedNext(
            `${c.req.header("x-forwarded-proto") === "http" ? "http" : "https"}://${host}${c.req.header("x-forwarded-uri") ?? "/"}`,
          )
        : null;
    if (!wanted) return c.text("Sign in to the studio first.", 401);
    return c.redirect(`${options.publicUrl}/sign-in?next=${encodeURIComponent(wanted)}`, 302);
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

    const pinned = c.req.query("v") === found.version;
    return c.body(found.body, 200, {
      "content-type": `${found.type}; charset=utf-8`,
      "cache-control": pinned ? "public, max-age=31536000, immutable" : "public, max-age=300",
      etag: `"${found.version}"`,
    });
  });

  app.get("/sign-in", (c) =>
    c.html(signInPage({ next: allowedNext(c.req.query("next")) ?? undefined })),
  );

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
    const next = allowedNext(form.get("next")) ?? undefined;
    if (!checkPassword(supplied, password)) {
      // Deliberately vague, and the same shape whether or not a password was supplied: there is nothing to learn from it.
      return c.html(signInPage({ error: "That password did not work.", next }), 401);
    }

    signInLimiter.clear(`sign-in:${address}`);
    c.header(
      "Set-Cookie",
      createSessionCookie(signingKey, { secure: isSecure(c), domain: options.cookieDomain }),
    );
    const sites = store.listSites();
    const only = sites.length === 1 ? `/sites/${sites[0]!.id}` : "/";
    return c.redirect(next ?? only, 303);
  });

  app.post("/sign-out", (c) => {
    c.header("Set-Cookie", clearSessionCookie(isSecure(c), options.cookieDomain));
    return c.redirect("/sign-in", 303);
  });

  app.get("/", (c) => c.html(sitesPage(store.listSites(), store.countUnread())));

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
          error: "Nothing was connected — check the dev server URL.",
          fieldErrors: { devUrl: DEV_URL_ERROR },
          values,
        }),
        422,
      );
    }

    if (values.path && !(await isDirectory(values.path))) {
      return c.html(
        newSitePage({
          error: "Nothing was connected — check the folder path.",
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

  app.get("/sites/:id/settings", (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    return c.html(newSitePage({ editing: site }));
  });

  app.post("/sites/:id/settings", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const form = await c.req.formData();
    const values = {
      name: String(form.get("name") ?? "").trim(),
      path: site.path,
      devUrl: String(form.get("devUrl") ?? "").trim(),
    };
    if (values.devUrl && !isHttpUrl(values.devUrl)) {
      return c.html(
        newSitePage({
          editing: site,
          values,
          error: "Nothing was saved — check the dev server URL.",
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
    });
    return c.redirect(`/sites/${site.id}`, 303);
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

  app.get("/sites/:id", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();

    try {
      const client = new SiteClient(site);
      const context = await client.context();
      return c.html(
        sitePage(
          site,
          context.schema,
          store.recentPublishes(site.id),
          undefined,
          await client.listLiveDrafts(context),
          `${publicOrigin(c)}/f/${encodeURIComponent(site.id)}`,
          await client.syncState(),
        ),
      );
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.post("/sites/:id/push", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const client = new SiteClient(site);
    const pushed = await client.push();
    if (pushed.ok) return c.redirect(`/sites/${site.id}`, 303);

    try {
      const context = await client.context();
      return c.html(
        sitePage(
          site,
          context.schema,
          store.recentPublishes(site.id),
          { kind: "error", message: pushed.reason },
          await client.listLiveDrafts(context),
          `${publicOrigin(c)}/f/${encodeURIComponent(site.id)}`,
          await client.syncState(),
        ),
        502,
      );
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

      const entries = await client.listEntries(context, name);
      return c.html(
        collectionPage({
          site,
          schema: context.schema,
          name,
          label: collection.label ?? name,
          entryLabel: collection.entryLabel,
          entries: entries.map((entry) => ({
            slug: entry.slug,
            title: String(
              entry.data[collection.slug ?? "title"] ??
                entry.data.title ??
                entry.data.name ??
                entry.slug,
            ),
            summary: (entry.data.summary ?? entry.data.description) as string | undefined,
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
      const data = draft ?? entry?.data;

      return c.html(
        editEntryPage({
          site,
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
          previewUrl: entryPreview(site, context.config, name, entry?.slug ?? null),
          errors: new Map(),
          headSha: context.headSha,
          mediaPreviews: committedPreviews(site.id, context.config, data),
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

      await client.deleteEntry({ context, name, slug, actor: c.get("actor") });
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

    const document = decodeForm(
      entries,
      collection.fields,
      blockFieldsOf(context),
      mdxBody(collection),
    );

    if (action.startsWith("nested:")) {
      const updated = applyNestedBlockAction(context.schema, collection, document, action, form);
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
            message: "Nothing was published — this entry is not valid yet.",
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
              message: `Nothing was published — “${slug}” is already taken.`,
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

    const written = await client.writeLiveDraft({ context, regionId, document });
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

    const document = decodeForm(
      await formEntries(c.req.raw),
      collection.fields,
      blockFieldsOf(context),
      mdxBody(collection),
    );
    const written = await client.writeLiveDraft({
      context,
      collection: { name, slug },
      document,
    });
    return c.body(null, written ? 204 : 409);
  });

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
      return c.html(
        editRegionPage({
          site,
          schema: context.schema,
          regionId,
          region,
          document,
          draft: draft !== null,
          previewUrl: site.devUrl ?? undefined,
          errors: new Map(),
          headSha: context.headSha,
          mediaPreviews: committedPreviews(site.id, context.config, document),
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
    const renderRegion = (view: RegionView) =>
      editRegionPage({
        site,
        schema: context.schema,
        regionId,
        region,
        previewUrl: site.devUrl ?? undefined,
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
            message: "Nothing was published — this content is not valid yet.",
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

  return app;
}

interface BlockActionResult {
  changed: boolean;
  open?: number;
}

function applyBlockAction(
  action: string,
  blocks: Array<Record<string, unknown>>,
  addType: string,
  allowed: string[],
): BlockActionResult {
  const [verb, rawIndex] = action.split(":");
  const index = Number(rawIndex);

  if (verb === "add" || action === "add") {
    if (!allowed.includes(addType)) return { changed: false };
    blocks.push({ _type: addType });
    return { changed: true, open: blocks.length - 1 };
  }
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
    return { changed: false };
  }

  if (verb === "remove") {
    blocks.splice(index, 1);
    return { changed: true };
  }
  const target = verb === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= blocks.length) return { changed: false };
  const [moved] = blocks.splice(index, 1);
  if (moved) blocks.splice(target, 0, moved);
  return moved ? { changed: true, open: target } : { changed: false };
}

/** Applies the same add/remove/reorder controls to a blocks field at any depth. */
function applyNestedBlockAction(
  schema: CmsSchema,
  root: RegionDef | CollectionDef,
  document: RegionDocument,
  action: string,
  form: FormData,
): { changed: boolean; open?: string } {
  const [, verb, encodedPath, rawIndex] = action.split(":");
  if (!verb || !encodedPath || !["add", "remove", "up", "down"].includes(verb)) {
    return { changed: false };
  }

  const path = encodedPath.split(".");
  const target = nestedBlockList(schema, root, document, path);
  if (!target) return { changed: false };

  const addType = String(form.get(fieldName(path, "nestedAdd")) ?? "");
  if (verb === "add" && !target.allowed.includes(addType)) return { changed: false };
  const updated = applyBlockAction(
    rawIndex === undefined ? verb : `${verb}:${rawIndex}`,
    target.blocks,
    addType,
    target.allowed,
  );
  return {
    changed: updated.changed,
    open: updated.open === undefined ? encodedPath : `${encodedPath}.${updated.open}`,
  };
}

function nestedParentBlock(action: string): number | undefined {
  const encodedPath = action.split(":")[2];
  const [root, rawIndex] = encodedPath?.split(".") ?? [];
  const index = Number(rawIndex);
  return root === "blocks" && Number.isInteger(index) && index >= 0 ? index : undefined;
}

function nestedBlockList(
  schema: CmsSchema,
  root: RegionDef | CollectionDef,
  document: RegionDocument,
  path: string[],
): { blocks: Array<Record<string, unknown>>; allowed: string[] } | null {
  let node = document as Record<string, unknown>;
  let fields: Record<string, FieldDef>;
  let offset = 0;

  if ("type" in root && root.type === "blocks") {
    if (path[0] !== "blocks") return null;
    const item = indexedBlock(node.blocks, path[1]);
    if (!item) return null;
    const definition = schema.blocks[String(item._type ?? "")];
    if (!definition) return null;
    node = item;
    fields = definition.fields;
    offset = 2;
  } else {
    fields = root.fields;
  }

  while (offset < path.length) {
    const name = path[offset];
    if (!name) return null;
    const definition = fields[name];
    if (!definition) return null;

    if (offset === path.length - 1) {
      if (definition.type !== "blocks") return null;
      const current = node[name];
      const blocks = Array.isArray(current) ? (current as Array<Record<string, unknown>>) : [];
      if (!Array.isArray(current)) node[name] = blocks;
      return { blocks, allowed: definition.allow };
    }

    if (definition.type === "group") {
      const child = objectValue(node[name]);
      node[name] = child;
      node = child;
      fields = definition.fields;
      offset += 1;
      continue;
    }

    if (definition.type !== "blocks") return null;
    const item = indexedBlock(node[name], path[offset + 1]);
    if (!item) return null;
    const block = schema.blocks[String(item._type ?? "")];
    if (!block) return null;
    node = item;
    fields = block.fields;
    offset += 2;
  }

  return null;
}

function indexedBlock(
  value: unknown,
  rawIndex: string | undefined,
): Record<string, unknown> | null {
  if (!Array.isArray(value) || !rawIndex || !/^\d+$/.test(rawIndex)) return null;
  const item = value[Number(rawIndex)];
  return typeof item === "object" && item !== null && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : null;
}

function objectValue(
  value: unknown,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fallback;
}

async function prepareMediaUploads(
  form: FormData,
  entries: Array<[string, string]>,
  config: CmsConfig,
): Promise<UploadResult[]> {
  const files = [...form.entries()].flatMap(([key, value]) => {
    if (typeof value === "string" || value.size === 0) return [];
    const path = parsePath(key, MEDIA_ROOT);
    return path ? [{ path, file: value }] : [];
  });

  const prepared = await Promise.all(
    files.map(async ({ path, file }) => ({
      path,
      upload: prepareUpload(config, {
        fileName: file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }),
    })),
  );

  return prepared.map(({ path, upload }) => {
    const field = fieldName(path);
    entries.push([`${field}[src]`, upload.src]);
    if (upload.width) entries.push([`${field}[width]`, String(upload.width)]);
    if (upload.height) entries.push([`${field}[height]`, String(upload.height)]);
    return upload;
  });
}

/** The images an edit was carrying are gone: expired, or the site was reconnected. */
class ExpiredMediaError extends UploadError {}

async function retainedMedia(
  store: Store,
  siteId: string,
  scope: string,
  form: FormData,
  entries: Array<[string, string]>,
  config: CmsConfig,
) {
  const previous = String(form.get("pendingMedia") ?? "");
  let kept: UploadResult[] = [];
  try {
    kept = previous ? store.pendingMedia(siteId, scope, previous) : [];
  } catch (error) {
    if (error instanceof UploadError) throw new ExpiredMediaError(error.message, error.fix);
    throw error;
  }
  const added = await prepareMediaUploads(form, entries, config);
  const files = [...new Map([...kept, ...added].map((file) => [file.path, file])).values()];
  const token = added.length
    ? store.savePendingMedia(siteId, scope, files, previous || undefined)
    : previous;
  return { token, files };
}

function referencedMedia(files: UploadResult[], document: Record<string, unknown>): FileChange[] {
  const sources = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("src" in value && typeof value.src === "string") sources.add(value.src);
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
  return files
    .filter((file) => sources.has(file.src))
    .map(({ path, base64 }) => ({ path, base64 }));
}

/** The field an MDX entry keeps as source: its JSX is not HTML, and sanitizing would delete it. */
function mdxBody(collection: CollectionDef): string | undefined {
  return collection.format === "mdx" ? collection.body : undefined;
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

/** Committed images by `src`, pointed at the studio: the site's own URL means nothing on this origin. */
function committedPreviews(
  siteId: string,
  config: CmsConfig,
  document: unknown,
): Record<string, string> {
  const prefix = `${config.mediaUrlPrefix.replace(/\/+$/, "")}/`;
  const previews: Record<string, string> = {};
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const src = (value as { src?: unknown }).src;
    if (
      typeof src === "string" &&
      src.startsWith(prefix) &&
      !src.slice(prefix.length).includes("/")
    ) {
      previews[src] =
        `/sites/${encodeURIComponent(siteId)}/media/${encodeURIComponent(src.slice(prefix.length))}`;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
  return previews;
}

function pendingPreviews(
  siteId: string,
  scope: string,
  token: string,
  files: UploadResult[],
): Record<string, string> {
  return token
    ? Object.fromEntries(
        files.map((file, index) => [
          file.src,
          `/sites/${encodeURIComponent(siteId)}/pending-media/${encodeURIComponent(token)}/${index}?scope=${encodeURIComponent(scope)}`,
        ]),
      )
    : {};
}

const DEV_URL_ERROR = "Use an address that starts with http:// or https://.";

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** A URL a browser will fetch, rather than one it will execute. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Only same-site paths: an open redirect would make this a phishing tool. */
export function isSafeRedirect(target: string): boolean {
  // Browsers read `/\host` and `/<tab>/host` as `//host`, so the raw string is not enough.
  if (!target.startsWith("/") || [...target].some(isUnsafeInPath)) return false;
  const base = "http://studio.invalid";
  try {
    return new URL(target, base).origin === base;
  } catch {
    return false;
  }
}

/** A body read up to `limit` bytes, or null past it, whatever content-length claimed. */
async function readLimited(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the stream, so an oversized body stops being read.
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function isUnsafeInPath(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return character === "\\" || code < 0x20 || code === 0x7f;
}

/**
 * The site a visitor submitted from. Redirecting there is not an open redirect: the
 * visitor was already on that page, and only the page itself chose to post here.
 */
function submittingOrigin(request: Request): string | null {
  for (const value of [request.headers.get("origin"), request.headers.get("referer")]) {
    if (!value || value === "null") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Not a URL, so not an origin to trust.
    }
  }
  return null;
}

function submissionId(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
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

/** Form fields as string pairs; uploads are not part of an unsaved draft. */
async function formEntries(request: Request): Promise<Array<[string, string]>> {
  const form = await request.formData();
  return [...form.entries()].map(
    ([key, value]) => [key, typeof value === "string" ? value : ""] as [string, string],
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** Where the preview should open for an entry: the page it is on, when the site's config says where that is. */
function entryPreview(
  site: Site,
  config: CmsConfig,
  collection: string,
  slug: string | null,
): string | undefined {
  if (!site.devUrl) return undefined;
  if (!slug) return site.devUrl;
  return new URL(previewPath(config, { collection, slug }), site.devUrl).href;
}

function errorPage(title: string, message: string): string {
  return page(
    { title, flash: { kind: "error", message } },
    html`<p><a class="button secondary" href="/">Back to sites</a></p>`,
  );
}

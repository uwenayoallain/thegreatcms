/** The studio's HTTP surface. */

import { readFile } from "node:fs/promises";
import {
  isBlocksRegion,
  isSafeSlug,
  type RegionDocument,
  validateFields,
  validateRegion,
} from "@greatcms/spec";
import { Hono } from "hono";
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
import { prepareUpload, UploadError } from "./media.js";
import {
  assessSpam,
  contentFields,
  type Notifier,
  RateLimiter,
  SPAM_THRESHOLD,
  toCsv,
} from "./submissions.js";
import { SiteClient, type SiteContext } from "./sites.js";
import { ConflictError } from "./repo.js";
import { errorsByPath } from "./views/fields.js";
import { page } from "./views/layout.js";
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
  trustProxy?: boolean;
}

/** Bodies a public visitor can post, past which this is not a contact form. */
const MAX_SUBMISSION_BYTES = 64 * 1024;
const MAX_SUBMISSION_FIELDS = 64;

type Variables = { actor: string };

export function createApp(options: AppOptions) {
  const { store, password, secret } = options;
  const app = new Hono<{ Variables: Variables }>();

  const limiter = options.rateLimiter ?? new RateLimiter();
  // Ten guesses per quarter hour: no bother to a person who mistyped, a wall to a script.
  const signInLimiter = options.signInLimiter ?? new RateLimiter(10, 15 * 60_000);
  const signingKey = sessionKey(secret, password);

  /** Who is asking, for rate limiting. */
  const addressOf = (c: { req: { header(name: string): string | undefined }; env: unknown }) => {
    if (options.trustProxy) {
      const forwarded =
        c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming
      ?.socket;
    return socket?.remoteAddress ?? "unknown";
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
   * `style-src` keeps 'unsafe-inline' because the stylesheet is inlined in
   * every page. That is the weakest line here and it is worth naming: CSS
   * injection is a real if lesser problem, and the fix is to serve the styles
   * as a file, not to pretend the directive is strict.
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

    // A contact form is not a file upload endpoint. Measured rather than believed:
    // content-length is the sender's claim about the sender's own body.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_SUBMISSION_BYTES) {
      return c.text("That submission is too large.", 413);
    }

    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_SUBMISSION_BYTES) {
      return c.text("That submission is too large.", 413);
    }

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

    const spam = assessSpam(fields);
    const data = contentFields(fields);
    store.addSubmission({
      siteId,
      form,
      data,
      spamScore: spam.score,
      spamReasons: spam.reasons,
    });

    if (options.notifier && spam.score < SPAM_THRESHOLD) {
      // Not awaited: the visitor should not wait on an email provider.
      void options.notifier.notify({
        subject: `${site.name}: new ${form} submission`,
        lines: Object.entries(data).map(([key, value]) => `${key}: ${value}`),
      });
    }

    // Send the visitor somewhere sensible with no JavaScript involved.
    const redirect = fields._redirect;
    if (redirect && isSafeRedirect(redirect)) return c.redirect(redirect, 303);
    return c.html(thanksPage(), 200);
  });

  app.use("*", async (c, next) => {
    // Managed sites post submissions from their own domains, so this one route is exempt.
    if (new URL(c.req.url).pathname.startsWith("/f/")) return next();

    if (c.req.method !== "GET" && !isSameOrigin(c.req.raw)) {
      return c.text("Cross-origin form posts are refused.", 403);
    }

    const path = new URL(c.req.url).pathname;
    if (path === "/sign-in") return next();

    const session = readSession(c.req.header("cookie"), signingKey);
    if (!session) {
      return c.req.method === "GET"
        ? c.redirect("/sign-in", 303)
        : c.text("Your session expired. Sign in and try again.", 401);
    }
    c.set("actor", session.actor);
    return next();
  });

  /** Client bundles. */
  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    if (!CLIENT_ASSETS.has(file)) return c.notFound();

    const asset = await clientAsset(file);
    if (!asset) return c.notFound();
    return c.body(asset, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  });

  app.get("/sign-in", (c) => c.html(signInPage()));

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

    const form = await c.req.formData();
    const supplied = String(form.get("password") ?? "");
    if (!checkPassword(supplied, password)) {
      // Deliberately vague, and the same shape whether or not a password was supplied: there.
      return c.html(signInPage({ error: "That password did not work." }), 401);
    }

    signInLimiter.clear(`sign-in:${address}`);
    c.header("Set-Cookie", createSessionCookie(signingKey, { secure: isSecure(c) }));
    return c.redirect("/", 303);
  });

  app.post("/sign-out", (c) => {
    c.header("Set-Cookie", clearSessionCookie(isSecure(c)));
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
    const form = await c.req.formData();
    store.markRead(Number(c.req.param("id")), String(form.get("read") ?? "1") === "1");
    return c.redirect("/inbox", 303);
  });

  app.post("/inbox/:id/delete", (c) => {
    store.deleteSubmission(Number(c.req.param("id")));
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
          error: "The dev server URL must start with http:// or https://.",
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
        ),
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
          name,
          label: collection.label ?? name,
          entries: entries.map((entry) => ({
            slug: entry.slug,
            title: String(entry.data.title ?? entry.slug),
            summary: entry.data.summary as string | undefined,
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

      return c.html(
        editEntryPage({
          site,
          name,
          label: collection.label ?? name,
          slug: entry?.slug ?? null,
          fields: collection.fields,
          format: collection.format,
          body: collection.body,
          blocks: context.schema.blocks,
          document: client.entryDocument(context, name, entry),
          errors: new Map(),
          headSha: context.headSha,
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
    const document = decodeForm(entries, collection.fields, blockFieldsOf(context));

    const validation = validateFields(collection.fields, document, {
      strict: false,
      blocks: context.schema.blocks,
    });
    if (!validation.ok) {
      return c.html(
        editEntryPage({
          site,
          name,
          label: collection.label ?? name,
          slug: requested === "new" ? null : requested,
          fields: collection.fields,
          format: collection.format,
          body: collection.body,
          blocks: context.schema.blocks,
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

    // A new entry takes its file name from the slug field; an existing one.
    const slug = requested === "new" ? client.entrySlug(context, name, document) : requested;

    try {
      const result = await client.publishEntry({
        context,
        name,
        slug,
        document,
        actor,
        expectedHeadSha: requested === "new" ? undefined : headSha || undefined,
      });

      // The published file is now the truth; a leftover draft would keep the dev.
      await client.clearLiveDraft({ context, collection: { name, slug } });

      store.recordPublish({
        siteId: site.id,
        regionId: `${name}/${slug}`,
        commitSha: result.commitSha,
        commitUrl: result.url,
        actor,
      });

      return c.html(
        editEntryPage({
          site,
          name,
          label: collection.label ?? name,
          slug,
          fields: collection.fields,
          format: collection.format,
          body: collection.body,
          blocks: context.schema.blocks,
          document,
          errors: new Map(),
          headSha: result.commitSha,
          flash: {
            kind: "success",
            message: `Published as ${result.commitSha.slice(0, 7)}.`,
          },
        }),
      );
    } catch (error) {
      return c.html(
        editEntryPage({
          site,
          name,
          label: collection.label ?? name,
          slug: requested === "new" ? null : slug,
          fields: collection.fields,
          format: collection.format,
          body: collection.body,
          blocks: context.schema.blocks,
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
    return c.redirect(`/sites/${site.id}/collections/${name}/${slug}`, 303);
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

      const document = await client.resolvedRegion(context, regionId);
      return c.html(
        editRegionPage({
          site,
          schema: context.schema,
          regionId,
          region,
          document,
          errors: new Map(),
          headSha: context.headSha,
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
    let media: Array<{ path: string; base64: string }> = [];
    try {
      const files = [...form.entries()].flatMap(([key, value]) => {
        if (typeof value === "string" || value.size === 0) return [];
        const path = parsePath(key, MEDIA_ROOT);
        return path ? [{ path, file: value }] : [];
      });

      // Reading the uploads runs at once; a publish with three images should not cost.
      const prepared = await Promise.all(
        files.map(async ({ path, file }) => ({
          path,
          upload: prepareUpload(context.config, {
            fileName: file.name,
            type: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          }),
        })),
      );

      for (const { path, upload } of prepared) {
        media.push({ path: upload.path, base64: upload.base64 });

        const field = fieldName(path);
        entries.push([`${field}[src]`, upload.src]);
        if (upload.width) entries.push([`${field}[width]`, String(upload.width)]);
        if (upload.height) entries.push([`${field}[height]`, String(upload.height)]);
      }
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      return c.html(
        editRegionPage({
          site,
          schema: context.schema,
          regionId,
          region,
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

    // Nothing is uploaded for a block-list shuffle; those never reach a commit.
    if (action !== "publish" && action !== "draft") media = [];

    // Block list edits round-trip through the server so add, remove, and reorder work without.
    if (action !== "publish" && action !== "draft" && isBlocksRegion(region)) {
      const blocks = document.blocks as Array<Record<string, unknown>>;
      applyBlockAction(action, blocks, String(form.get("addType") ?? ""), region.allow);
      return c.html(
        editRegionPage({
          site,
          schema: context.schema,
          regionId,
          region,
          document: { blocks },
          errors: new Map(),
          headSha,
          flash: { kind: "success", message: "Block list updated. Publish to save it." },
        }),
      );
    }

    const validation = validateRegion(context.schema, regionId, document, { strict: false });
    if (!validation.ok) {
      return c.html(
        editRegionPage({
          site,
          schema: context.schema,
          regionId,
          region,
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
        media,
      });
      await client.clearLiveDraft({ context, regionId });

      store.recordPublish({
        siteId: site.id,
        regionId,
        commitSha: result.commitSha,
        commitUrl: result.url,
        actor,
      });
      return c.html(
        editRegionPage({
          site,
          schema: context.schema,
          regionId,
          region,
          document,
          errors: new Map(),
          headSha: result.commitSha,
          flash: {
            kind: "success",
            message: `Published as ${result.commitSha.slice(0, 7)}. Your deploy pipeline takes it from here.`,
          },
        }),
      );
    } catch (error) {
      const conflict = error instanceof ConflictError;
      return c.html(
        editRegionPage({
          site,
          schema: context.schema,
          regionId,
          region,
          document,
          errors: new Map(),
          headSha: conflict ? context.headSha : headSha,
          flash: { kind: "error", message: describeError(error) },
        }),
        conflict ? 409 : 502,
      );
    }
  });

  app.notFound((c) => c.html(errorPage("Not found", "That page does not exist."), 404));

  return app;
}

function applyBlockAction(
  action: string,
  blocks: Array<Record<string, unknown>>,
  addType: string,
  allowed: string[],
): void {
  const [verb, rawIndex] = action.split(":");
  const index = Number(rawIndex);

  if (verb === "add" || action === "add") {
    if (allowed.includes(addType)) blocks.push({ _type: addType });
    return;
  }
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) return;

  if (verb === "remove") {
    blocks.splice(index, 1);
    return;
  }
  const target = verb === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= blocks.length) return;
  const [moved] = blocks.splice(index, 1);
  if (moved) blocks.splice(target, 0, moved);
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
function isSafeRedirect(target: string): boolean {
  return target.startsWith("/") && !target.startsWith("//");
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

const CLIENT_ASSETS = new Set(["editor.js", "live.js"]);
const assetCache = new Map<string, string | null>();

/** Resolved next to the built server bundle, and beside the source in dev. */
async function clientAsset(file: string): Promise<string | null> {
  const cached = assetCache.get(file);
  if (cached !== undefined) return cached;

  const found = await Promise.all(
    [`../public/${file}`, `./public/${file}`].map(async (candidate) => {
      try {
        return await readFile(new URL(candidate, import.meta.url), "utf8");
      } catch {
        return null;
      }
    }),
  );

  const content = found.find((value) => value !== null) ?? null;
  assetCache.set(file, content);
  return content;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function errorPage(title: string, message: string): string {
  return page({ title, flash: { kind: "error", message } }, '<p><a href="/">Back to sites</a></p>');
}

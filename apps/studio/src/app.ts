/**
 * The studio's HTTP surface.
 *
 * Every screen is server-rendered and every mutation is a form POST, so the
 * whole editor works with JavaScript disabled. That is not nostalgia: it makes
 * the admin keyboard- and screen-reader-accessible by construction, and keeps
 * the client payload at zero.
 */

import { readFile } from "node:fs/promises";
import { ConflictError, GitHubError } from "@greatcms/git";
import {
  isBlocksRegion,
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
} from "./auth.js";
import type { Site, SiteKind, Store } from "./db.js";
import { decodeBlocks, decodeForm, fieldName, MEDIA_ROOT, parsePath } from "./form.js";
import { prepareUpload, UploadError } from "./media.js";
import { deterministicSummarizer, diffDocuments, type Summarizer } from "./summarize.js";
import {
  assessSpam,
  contentFields,
  type Notifier,
  RateLimiter,
  SPAM_THRESHOLD,
  toCsv,
} from "./submissions.js";
import { SiteClient, SiteNotConfiguredError, type SiteContext } from "./sites.js";
import { errorsByPath } from "./views/fields.js";
import { previewDocument } from "./views/preview.js";
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
  /** Names pull requests. Defaults to the deterministic, model-free one. */
  summarizer?: Summarizer;
  rateLimiter?: RateLimiter;
}

type Variables = { actor: string };

export function createApp(options: AppOptions) {
  const { store, password, secret } = options;
  const app = new Hono<{ Variables: Variables }>();

  const clientFor = (site: Site) => new SiteClient(site, options.fetch);
  const limiter = options.rateLimiter ?? new RateLimiter();

  /**
   * The public submission endpoint. It sits before authentication and before
   * the same-origin check on purpose: managed sites post here from their own
   * domains, which is cross-origin by definition. It accepts only form data,
   * writes only to the submissions table, and never reads a session.
   */
  app.post("/f/:siteId/:form", async (c) => {
    const siteId = c.req.param("siteId");
    const form = c.req.param("form").slice(0, 64);
    const site = store.getSite(siteId);
    if (!site) return c.text("Unknown site.", 404);

    const address =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const limit = limiter.check(`${siteId}:${address}`);
    if (!limit.allowed) {
      return c.text("Too many submissions. Try again shortly.", 429, {
        "retry-after": String(limit.retryAfterSeconds),
      });
    }

    const body = await c.req.formData();
    const fields: Record<string, string> = {};
    for (const [key, value] of body.entries()) {
      if (typeof value === "string") fields[key.slice(0, 64)] = value.slice(0, 10_000);
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
      // Not awaited: the visitor should not wait on an email provider, and the
      // submission is already stored.
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
    // Managed sites post submissions from their own domains, so this one route
    // is exempt from both the origin check and the session requirement.
    if (new URL(c.req.url).pathname.startsWith("/f/")) return next();

    if (c.req.method !== "GET" && !isSameOrigin(c.req.raw)) {
      return c.text("Cross-origin form posts are refused.", 403);
    }

    const path = new URL(c.req.url).pathname;
    if (path === "/sign-in") return next();

    const session = readSession(c.req.header("cookie"), secret);
    if (!session) {
      return c.req.method === "GET"
        ? c.redirect("/sign-in", 303)
        : c.text("Your session expired. Sign in and try again.", 401);
    }
    c.set("actor", session.actor);
    return next();
  });

  /**
   * Client bundles. An allowlist rather than a static directory: the studio
   * serves exactly two files, and a path-traversal bug in a file server is a
   * silly way to lose a token database.
   */
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
    const form = await c.req.formData();
    const supplied = String(form.get("password") ?? "");
    if (!checkPassword(supplied, password)) {
      // Deliberately vague, and the same shape whether or not a password was
      // supplied: there is nothing here worth confirming to a guesser.
      return c.html(signInPage({ error: "That password did not work." }), 401);
    }
    c.header("Set-Cookie", createSessionCookie(secret));
    return c.redirect("/", 303);
  });

  app.post("/sign-out", (c) => {
    c.header("Set-Cookie", clearSessionCookie());
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
    const kind: SiteKind = form.get("kind") === "local" ? "local" : "github";
    const values = {
      kind,
      name: String(form.get("name") ?? "").trim(),
      path: String(form.get("path") ?? "").trim(),
      devUrl: String(form.get("devUrl") ?? "").trim(),
      owner: String(form.get("owner") ?? "").trim(),
      repo: String(form.get("repo") ?? "").trim(),
      branch: String(form.get("branch") ?? "main").trim() || "main",
    };
    const token = String(form.get("token") ?? "").trim();

    const missing =
      !values.name || (kind === "local" ? !values.path : !values.owner || !values.repo || !token);
    if (missing) {
      return c.html(
        newSitePage({
          error:
            kind === "local"
              ? "A name and the folder's path are required."
              : "Name, owner, repository, and token are all required.",
          values,
        }),
        422,
      );
    }

    const candidate: Site = {
      id: crypto.randomUUID(),
      ...values,
      token,
      // A folder has no pull requests to open.
      publishMode:
        kind === "github" && form.get("publishMode") === "pull-request" ? "pull-request" : "direct",
      aiTitles: form.get("aiTitles") === "yes",
      createdAt: new Date().toISOString(),
    };

    // Verify before storing: a site that cannot be read is not connected, and
    // finding that out at save time beats finding out mid-edit.
    try {
      await clientFor(candidate).context();
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
      const { schema } = await clientFor(site).context();
      return c.html(sitePage(site, schema, store.recentPublishes(site.id)));
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.post("/sites/:id/delete", (c) => {
    store.removeSite(c.req.param("id"));
    return c.redirect("/", 303);
  });

  /**
   * Collections are edited with the same generated forms and the same
   * validation as regions; only the file they land in differs. Keeping one
   * editing path means a Markdown blog post gets the same alt-text enforcement
   * and the same atomic publish as a hero section.
   */
  app.get("/sites/:id/collections/:name", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");

    try {
      const client = clientFor(site);
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

    try {
      const client = clientFor(site);
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

    try {
      const client = clientFor(site);
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
    const actor = c.get("actor");

    const client = clientFor(site);
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
    const document = decodeForm(entries, collection.fields);

    const validation = validateFields(collection.fields, document, { strict: false });
    if (!validation.ok) {
      return c.html(
        editEntryPage({
          site,
          name,
          label: collection.label ?? name,
          slug: requested === "new" ? null : requested,
          fields: collection.fields,
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

    // A new entry takes its file name from the slug field; an existing one keeps
    // the name it has, so renaming a title never orphans a published URL.
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
          document,
          errors: new Map(),
          headSha,
          flash: { kind: "error", message: describeError(error) },
        }),
        error instanceof ConflictError ? 409 : 502,
      );
    }
  });

  app.post("/sites/:id/regions/:regionId/preview", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const regionId = c.req.param("regionId");

    const client = clientFor(site);
    const context = await client.context();
    const region = context.schema.regions[regionId];
    if (!region) return c.notFound();

    const form = await c.req.formData();
    const entries: Array<[string, string]> = [...form.entries()].map(
      ([key, value]) => [key, typeof value === "string" ? value : ""] as [string, string],
    );

    const document = isBlocksRegion(region)
      ? { blocks: decodeBlocks(entries, (type) => context.schema.blocks[type]?.fields) }
      : decodeForm(entries, region.fields);

    return c.html(
      previewDocument({
        title: region.label ?? regionId,
        region,
        blocks: context.schema.blocks,
        fields: isBlocksRegion(region) ? undefined : region.fields,
        document,
      }),
    );
  });

  app.post("/sites/:id/collections/:name/:slug/preview", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");

    const context = await clientFor(site).context();
    const collection = context.schema.collections[name];
    if (!collection) return c.notFound();

    const form = await c.req.formData();
    const entries: Array<[string, string]> = [...form.entries()].map(
      ([key, value]) => [key, typeof value === "string" ? value : ""] as [string, string],
    );

    return c.html(
      previewDocument({
        title: collection.label ?? name,
        fields: collection.fields,
        document: decodeForm(entries, collection.fields),
      }),
    );
  });

  app.get("/sites/:id/regions/:regionId", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const regionId = c.req.param("regionId");

    try {
      const client = clientFor(site);
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

    const client = clientFor(site);
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

    // Uploads ride along in the same form, keyed by the field they belong to,
    // so an image and the content referencing it are one submission and one
    // commit. Each upload is turned into ordinary form entries before decoding,
    // so an uploaded image travels the same path as a pasted URL — and the alt
    // text typed beside it is picked up with everything else.
    let media: Array<{ path: string; base64: string }> = [];
    try {
      const files = [...form.entries()].flatMap(([key, value]) => {
        if (typeof value === "string" || value.size === 0) return [];
        const path = parsePath(key, MEDIA_ROOT);
        return path ? [{ path, file: value }] : [];
      });

      // Reading the uploads runs at once; a publish with three images should
      // not cost three sequential reads before it even starts committing.
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
            : decodeForm(entries, region.fields),
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
      : decodeForm(entries, region.fields);

    // Nothing is uploaded for a block-list shuffle; those never reach a commit.
    if (action !== "publish" && action !== "draft") media = [];

    // Block list edits round-trip through the server so add, remove, and
    // reorder work without a line of client JavaScript.
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

    if (action === "draft") {
      try {
        const draft = await client.saveDraft({ context, regionId, document, actor, media });
        return c.html(
          editRegionPage({
            site,
            schema: context.schema,
            regionId,
            region,
            document,
            errors: new Map(),
            headSha,
            preview: { url: draft.previewUrl, branch: draft.branch },
            flash: {
              kind: "success",
              message: `Saved to ${draft.branch}. Nothing on ${site.branch} has changed.`,
            },
          }),
        );
      } catch (error) {
        return c.html(errorPage(site.name, describeError(error)), 502);
      }
    }

    if (site.publishMode === "pull-request") {
      try {
        const published = await client.readRegion(context, regionId);
        const changes = diffDocuments(published, document);
        const summarizer =
          site.aiTitles && options.summarizer ? options.summarizer : deterministicSummarizer;

        const summary = await summarizer.summarize({
          siteName: site.name,
          regionId,
          regionLabel: region.label ?? regionId,
          changes,
        });

        const proposal = await client.proposeRegion({
          context,
          regionId,
          document,
          title: summary.title,
          body: summary.body,
          actor,
          media,
        });

        store.recordPublish({
          siteId: site.id,
          regionId,
          commitSha: proposal.commit.commitSha,
          commitUrl: proposal.commit.url,
          actor,
          pullRequestUrl: proposal.pullRequest.url,
        });

        return c.html(
          editRegionPage({
            site,
            schema: context.schema,
            regionId,
            region,
            document,
            errors: new Map(),
            headSha,
            preview: { url: proposal.previewUrl, branch: proposal.commit.branch },
            pullRequest: { ...proposal.pullRequest, fromModel: summary.fromModel },
            flash: {
              kind: "success",
              message: proposal.pullRequest.created
                ? `Opened pull request #${proposal.pullRequest.number}. Nothing is live until it is merged.`
                : `Updated pull request #${proposal.pullRequest.number}. Nothing is live until it is merged.`,
            },
          }),
        );
      } catch (error) {
        return c.html(errorPage(site.name, describeError(error)), 502);
      }
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

const CLIENT_ASSETS = new Set(["editor.js", "preview.js"]);
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
  if (error instanceof SiteNotConfiguredError) return error.message;
  if (error instanceof GitHubError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function errorPage(title: string, message: string): string {
  return page({ title, flash: { kind: "error", message } }, '<p><a href="/">Back to sites</a></p>');
}

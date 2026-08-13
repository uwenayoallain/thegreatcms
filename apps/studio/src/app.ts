/**
 * The studio's HTTP surface.
 *
 * Every screen is server-rendered and every mutation is a form POST, so the
 * whole editor works with JavaScript disabled. That is not nostalgia: it makes
 * the admin keyboard- and screen-reader-accessible by construction, and keeps
 * the client payload at zero.
 */

import { ConflictError, GitHubError } from "@greatcms/git";
import { isBlocksRegion, type RegionDocument, validateRegion } from "@greatcms/spec";
import { Hono } from "hono";
import {
  checkPassword,
  clearSessionCookie,
  createSessionCookie,
  isSameOrigin,
  readSession,
} from "./auth.js";
import type { Site, Store } from "./db.js";
import { decodeBlocks, decodeForm } from "./form.js";
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
import { page } from "./views/layout.js";
import {
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
    const values = {
      name: String(form.get("name") ?? "").trim(),
      owner: String(form.get("owner") ?? "").trim(),
      repo: String(form.get("repo") ?? "").trim(),
      branch: String(form.get("branch") ?? "main").trim() || "main",
    };
    const token = String(form.get("token") ?? "").trim();

    if (!values.name || !values.owner || !values.repo || !token) {
      return c.html(newSitePage({ error: "Every field is required.", values }), 422);
    }

    const candidate: Site = {
      id: crypto.randomUUID(),
      ...values,
      token,
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
    const entries = [...form.entries()].map(
      ([key, value]) => [key, typeof value === "string" ? value : ""] as [string, string],
    );
    const action = String(form.get("action") ?? "publish");
    const headSha = String(form.get("headSha") ?? "");

    const document: RegionDocument = isBlocksRegion(region)
      ? {
          blocks: decodeBlocks(entries, (type) => context.schema.blocks[type]?.fields),
        }
      : decodeForm(entries, region.fields);

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
        const draft = await client.saveDraft({ context, regionId, document, actor });
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

    try {
      const result = await client.publishRegion({
        context,
        regionId,
        document,
        actor,
        expectedHeadSha: headSha || undefined,
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

function describeError(error: unknown): string {
  if (error instanceof SiteNotConfiguredError) return error.message;
  if (error instanceof GitHubError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function errorPage(title: string, message: string): string {
  return page({ title, flash: { kind: "error", message } }, '<p><a href="/">Back to sites</a></p>');
}

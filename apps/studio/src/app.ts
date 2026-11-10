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
import { pack } from "./pack.js";
import { setFlagsFromString } from "node:v8";
import { SiteAccess } from "./access.js";
import {
  checkPassword,
  clearFlash,
  clearGithubTrip,
  flashCookie,
  hasFlash,
  readFlash,
  clearPreviewCookie,
  clearSessionCookie,
  readGithubTrip,
  sameText,
  startGithubTrip,
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
import type { GithubPerson, Site, Store } from "./db.js";
import { decodeBlocks, decodeForm } from "./form.js";
import { ALLOWED_TYPES, MAX_BYTES, UploadError, type UploadResult } from "./media.js";
import {
  replyAddress,
  assessSpam,
  contentFields,
  type Notifier,
  RateLimiter,
  SPAM_THRESHOLD,
  toCsv,
} from "./submissions.js";
import { SiteClient, type SiteContext, entryTitle } from "./sites.js";
import { type Author, type BranchState, ConflictError } from "./repo.js";
import { type Viewer, withViewer } from "./views/viewer.js";
import { THEME_COOKIE, THEMES, themeOf, withTheme } from "./views/theme.js";
import { panesOf, withChrome } from "./views/chrome.js";
import { errorsByPath, issueLines } from "./views/fields.js";
import { page, type PageOptions } from "./views/layout.js";
import { asset, compressed, icon, ICONS } from "./assets.js";
import {
  editorsPage,
  type GitHubView,
  gitAccessPage,
  githubCreatePage,
  noAccessPage,
  shareCard,
  sharePage,
  shareProblemPage,
  signInPage,
} from "./views/account-pages.js";
import { collectionPage, editEntryPage } from "./views/collection-pages.js";
import { inboxPage } from "./views/inbox-page.js";
import { editRegionPage } from "./views/region-page.js";
import { sitePage } from "./views/site-page.js";
import { newSitePage, setupPage, sitesPage } from "./views/sites-pages.js";
import {
  type CloneGit,
  type CloneLimits,
  Clones,
  cloneUrlProblem,
  folderFromUrl,
  folderPath,
  hasSchema,
  isBranchName,
  isFolderName,
  reachesPrivateNetwork,
  type ResolveHost,
  isInside,
  listFolders,
  nameFromFolder,
  originOf,
  PreviewAddresses,
  sameRepository,
  warmPreview,
  type Folder,
  previewEntries,
  writePreviewList,
} from "./connect.js";
import { planStarter, TEMPLATES, type TemplateId } from "@greatcms/cli/starter";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LocalRepository } from "./repo.js";
import type { GitAccess } from "./git-access.js";
import { type GitHub, SIGN_IN_CALLBACK } from "./github.js";
import { useRemoteAuth } from "./repo.js";
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
  /** `STUDIO_OWNER_NAME`: what the person who signs in with the studio's password is called. */
  ownerName?: string;
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
  /** The folder holding sites (`STUDIO_SITES_ROOT`): listed on the connect page, and where clones go. */
  sitesRoot?: string;
  /** `STUDIO_PREVIEW_URL`, e.g. `https://{site}-preview.example.com`: a new site's preview address. */
  previewUrl?: string;
  /** `STUDIO_PREVIEWS_FILE`: where the list of those previews is written for the preview service. */
  previewsFile?: string;
  /** `STUDIO_PREVIEW_PROBE`: where this server reaches the preview service, to say whether it is up. */
  previewProbe?: string;
  /** Tokens for Git hosts other than GitHub. */
  gitAccess?: GitAccess;
  /** The GitHub App this studio connects GitHub through. */
  github?: GitHub;
  /**
   * `STUDIO_GITHUB_OWNERS`: GitHub logins that are owners here once they sign in. Unset, the
   * account that owns the GitHub App is one, when that account is a person.
   */
  githubOwners?: string[];
  /** Replaces reading a site's origin remote, in tests. */
  originOf?: (path: string) => Promise<string | null>;
  /** Replaces git for clones, in tests. */
  cloneGit?: CloneGit;
  /** How many copies run at once and how large one may grow. */
  cloneLimits?: Partial<CloneLimits>;
  /**
   * `STUDIO_CLONE_PRIVATE=1`: lets Copy from Git reach this machine and its private network,
   * for a Git server that lives there. Off by default, so the form cannot be pointed inward.
   */
  clonePrivate?: boolean;
  /** Replaces DNS for the check above, in tests. */
  resolveHost?: ResolveHost;
  /** Submissions one site may store per day, whoever sends them. Injected by tests. */
  siteSubmissionLimiter?: RateLimiter;
  /** Notification emails one site may send per hour. Injected by tests. */
  notificationLimiter?: RateLimiter;
  /** `greatcms studio`: one project, the folder it was started in, and nothing about other sites or people. */
  local?: boolean;
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

type Variables = {
  actor: string;
  viewer: Viewer;
  session: string;
  /** The sites this person may open: every site, or for a GitHub sign-in those they can push to. */
  sites: Site[];
  /** Those sites' ids when they are not all of them, to keep the inbox to the same ones. */
  among?: string[];
  /** Another origin this one page may post a form to, such as GitHub. */
  formTarget?: string;
  /** Why a "publish later" was not scheduled; the editor shows it with the form as submitted. */
  refused?: string;
};

export function createApp(options: AppOptions) {
  const { store, password, secret } = options;
  const app = new Hono<{ Variables: Variables }>();
  const limiter = options.rateLimiter ?? new RateLimiter();
  const previews = options.previewUrl ? new PreviewAddresses(options.previewUrl) : undefined;
  const managed = (site: Site) =>
    previews?.nameOf(site.devUrl) ? options.previewProbe : undefined;
  const liveness = new Liveness(options.probeUrls, managed, (site) => {
    const probe = managed(site);
    if (probe) warmPreview(probe, site.devUrl);
  });
  const clones = options.sitesRoot
    ? new Clones(options.sitesRoot, options.cloneGit, options.cloneLimits)
    : undefined;
  // Pushes to a repository the GitHub App reaches sign in with a token minted for that push.
  useRemoteAuth(
    options.github
      ? (url) => (options.github as GitHub).gitConfigFor(url).catch(() => [])
      : undefined,
  );
  /** Keeps the preview service's list in step with the sites, after every change to them. */
  const sitesChanged = () => {
    if (!previews || !options.previewsFile) return;
    try {
      writePreviewList(options.previewsFile, previewEntries(store.listSites(), previews));
    } catch (error) {
      process.stderr.write(`could not write ${options.previewsFile}: ${describeError(error)}\n`);
    }
  };
  sitesChanged();
  // Per-address limits stop one sender; these stop many senders filling the inbox and the mail quota.
  const siteSubmissions = options.siteSubmissionLimiter ?? new RateLimiter(1000, 24 * 60 * 60_000);
  const notifications = options.notificationLimiter ?? new RateLimiter(60, 60 * 60_000);
  // Ten guesses per quarter hour: no bother to a person who mistyped, a wall to a script.
  const signInLimiter = options.signInLimiter ?? new RateLimiter(10, 15 * 60_000);
  const signingKey = sessionKey(secret, password);
  const ownerName = options.ownerName?.trim().slice(0, 80) || "Owner";
  const timeZone = options.timeZone ?? studioTimeZone();

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
    const started = performance.now();
    await next();

    // On everything, a CSV or an image included: never guessed at, never sent on, never over plain HTTP again.
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "same-origin");
    c.res.headers.set("permissions-policy", PERMISSIONS_POLICY);
    if (isSecure(c)) c.res.headers.set("strict-transport-security", "max-age=31536000");
    // How long the studio took, for whoever is signed in and looking at the network panel.
    if (c.get("viewer")) {
      c.res.headers.set("server-timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
    }

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
        c.get("formTarget") ? `${formAction} ${c.get("formTarget")}` : formAction,
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    );
    // A tab the studio opens, such as the site itself, gets no handle back on the signed-in window.
    c.res.headers.set("cross-origin-opener-policy", "same-origin");
    // A studio is never a search result, and never a shared browser's history.
    c.res.headers.set("cache-control", "no-store");
  });
  // After the headers above: registered before them, compressing drops them on the Node server.
  app.use("*", pack);

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

    const data = contentFields(fields);
    // Nothing was written in it: the visitor is answered as usual, and no blank card is kept.
    const blank = Object.values(data).every((value) => value.trim() === "");
    const budget = blank ? null : siteSubmissions.check(siteId);
    if (budget && !budget.allowed) {
      return c.text("This site is receiving too many submissions. Try again later.", 429, {
        "retry-after": String(budget.retryAfterSeconds),
      });
    }

    const spam = assessSpam(fields);
    if (!blank) {
      store.addSubmission({
        siteId,
        form,
        data,
        spamScore: spam.score,
        spamReasons: spam.reasons,
      });
    }

    if (
      !blank &&
      options.notifier &&
      spam.score < SPAM_THRESHOLD &&
      notifications.check(siteId).allowed
    ) {
      // Not awaited: the visitor should not wait on an email provider.
      void options.notifier.notify({
        kind: "submission",
        subject: `${site.name}: new ${form} submission`,
        lines: Object.entries(data).map(([key, value]) => `${key}: ${value}`),
        site: site.name,
        form,
        fields: data,
        replyTo: replyAddress(data),
        // Only an address the operator set: the request's own host is the visitor's to choose.
        inbox: options.publicUrl
          ? `${options.publicUrl}/inbox?site=${encodeURIComponent(site.id)}`
          : undefined,
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

  const hub = options.local ? undefined : options.github;
  const access = hub ? new SiteAccess(hub, options.originOf) : undefined;
  /** Whether people can sign in with GitHub: never in local mode, and only with the app's secret. */
  const githubSignIn = () => Boolean(hub?.signIn());
  const namedOwners = (options.githubOwners ?? [])
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  /** The logins that are owners here, for the Git access page. */
  const githubOwners = () => {
    if (namedOwners.length > 0) return namedOwners;
    const made = hub?.config();
    return made?.ownerType === "User" && made.owner ? [made.owner] : [];
  };
  const isGithubOwner = (person: GithubPerson) => {
    const login = person.login.toLowerCase();
    if (namedOwners.length > 0) return namedOwners.includes(login);
    const made = hub?.config();
    if (made?.ownerType !== "User") return false;
    return made.ownerId === undefined
      ? made.owner.toLowerCase() === login
      : made.ownerId === person.id;
  };
  /** Ends with the app it was made through, and with the person being forgotten. */
  const githubStamp = (person: GithubPerson) =>
    editorStamp(signingKey, `${person.salt}:${hub?.config()?.id ?? ""}`);
  const noreply = hub
    ? `users.noreply.${new URL(hub.web).host.replace(/^www\./, "")}`
    : "users.noreply.github.com";

  /** Who a signed session belongs to now: null once an editor is removed or their password changes. */
  const viewerOf = (session: Session | null): Viewer | null => {
    if (!session || store.isSessionRevoked(session.id)) return null;
    if (session.actor === "studio") return { name: ownerName, owner: true };
    if (session.actor.startsWith("github:")) {
      if (!githubSignIn()) return null;
      const person = store.getGithubPerson(Number(session.actor.slice("github:".length)));
      if (!person || !sameText(session.stamp, githubStamp(person))) return null;
      return {
        name: person.name,
        owner: isGithubOwner(person),
        github: {
          id: person.id,
          login: person.login,
          email: `${person.id}+${person.login}@${noreply}`,
        },
      };
    }
    const editor = store.getEditor(Number(session.actor.slice("editor:".length)));
    if (!editor || session.stamp !== editorStamp(signingKey, editor.passwordHash)) return null;
    return { name: editor.name, email: editor.email, owner: false };
  };
  const stampFor = (actor: string) => {
    if (actor === "studio") return "-";
    if (actor.startsWith("github:")) {
      const person = store.getGithubPerson(Number(actor.slice("github:".length)));
      return person ? githubStamp(person) : "-";
    }
    const editor = store.getEditor(Number(actor.slice("editor:".length)));
    return editor ? editorStamp(signingKey, editor.passwordHash) : "-";
  };
  /** The sites someone may open: all of them, unless GitHub is what let them in. */
  const sitesFor = async (who: Viewer) => {
    const all = store.listSites();
    if (!who.github || who.owner) return { sites: all };
    const sites = access ? await access.among(who.github, all) : [];
    return { sites, among: sites.map((site) => site.id) };
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
  /** Stops the sessions a browser arrived with from working, in any copy of them. */
  const retire = (c: Context) => {
    const cookies = c.req.header("cookie");
    for (const session of [
      readSession(cookies, signingKey),
      readPreviewSession(cookies, signingKey),
    ]) {
      if (session) store.revokeSession(session.id, session.expiresAt);
    }
  };
  const signOut = (c: Context) => {
    // Clearing the cookie is the browser's part; a copy of it must stop working as well.
    retire(c);
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
      path === "/sign-in/github" ||
      path === SIGN_IN_CALLBACK ||
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
    const mine = await sitesFor(who);
    c.set("sites", mine.sites);
    c.set("among", mine.among);
    // A notice an action left behind: shown by the first page drawn after it, then forgotten.
    const waiting =
      c.req.method === "GET" ? readFlash(c.req.header("cookie"), signingKey, session.actor) : null;
    let shown = false;
    const shell = {
      ...panesOf(c.req.header("cookie")),
      unread: () => store.countUnread(mine.among),
      local: options.local,
      timeZone,
      flash: () => {
        shown = true;
        return waiting ?? undefined;
      },
    };
    await withViewer(who, () => withChrome(shell, next));
    const stale = c.req.method === "GET" && !waiting && hasFlash(c.req.header("cookie"));
    if ((shown && waiting) || (stale && c.res.status === 200)) {
      c.header("Set-Cookie", clearFlash(isSecure(c)), { append: true });
    }
  });

  /** Answers an action with a redirect, and a notice for the page it lands on. */
  const done = (
    c: Context<{ Variables: Variables }>,
    to: string,
    message: string,
    kind: "success" | "error" = "success",
  ) => {
    c.header(
      "Set-Cookie",
      flashCookie(signingKey, c.get("session"), { kind, message }, isSecure(c)),
      { append: true },
    );
    return c.redirect(to, 303);
  };

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

  if (options.local) {
    // One project: there is nothing to connect, copy, hand to other people, or disconnect.
    for (const route of [
      "/sites/new",
      "/sites/setup",
      "/sites/clone",
      "/sites/clone/*",
      "/git-access",
      "/git-access/*",
      "/editors",
      "/editors/*",
      "/sites/:id/delete",
    ]) {
      app.all(route, (c) => c.notFound());
    }
    app.post("/sites", (c) => c.notFound());
    app.get("/", (c) => {
      const [site] = store.listSites();
      return site ? c.redirect(`/sites/${site.id}`, 303) : c.notFound();
    });
  }

  // Sites and people are the owner's to change; editors change content. Attached to the
  // routes through the router, so no spelling of a path reaches one without passing here.
  const ownerOnly: MiddlewareHandler = async (c, next) => {
    if (c.get("viewer")?.owner) return next();
    return c.html(errorPage("Only the owner can do that", "Ask whoever runs this studio."), 403);
  };
  // The sidebar calls the list "Sites"; its address is the home page.
  app.get("/sites", (c) => c.redirect("/", 301));
  for (const route of [
    "/sites",
    "/sites/new",
    "/sites/setup",
    "/sites/clone",
    "/sites/clone/*",
    "/git-access",
    "/git-access/*",
    "/sites/:id/settings",
    "/sites/:id/delete",
    "/editors",
    "/editors/*",
  ]) {
    app.use(route, ownerOnly);
  }

  // A site someone cannot open does not exist for them, by any address under it. Anything that
  // changes the site asks GitHub again first, so access taken away there ends here at once.
  const reachable: MiddlewareHandler = async (c, next) => {
    const who = c.get("viewer") as Viewer | undefined;
    if (!who?.github || who.owner) return next();
    const site = (c.get("sites") as Site[]).find((known) => known.id === c.req.param("id"));
    if (!site) return c.notFound();
    const changes = c.req.method !== "GET" && !c.req.path.endsWith("/draft");
    if (changes && !(await access?.reaches(who.github, site, true))) return c.notFound();
    return next();
  };
  app.use("/sites/:id", reachable);
  app.use("/sites/:id/*", reachable);

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
  const shareRound = (siteId: string) => store.shareRound(siteId);
  /** A share token is good for the preview host of the site it names, and no other. */
  const shareFits = (token: string | undefined, host: string | undefined) => {
    const siteId = readShareToken(token, signingKey, shareRound);
    const site = siteId ? store.getSite(siteId) : null;
    if (!site?.devUrl || !host) return false;
    try {
      return new URL(site.devUrl).host === host;
    } catch {
      return false;
    }
  };

  app.get("/auth/check", async (c) => {
    const cookies = c.req.header("cookie");
    const host = c.req.header("x-forwarded-host");
    const who =
      viewerOf(readPreviewSession(cookies, signingKey)) ??
      viewerOf(readSession(cookies, signingKey));
    // A GitHub sign-in opens the previews of the sites it opens, and no one else's.
    const theirs = async (person: Viewer) =>
      (await sitesFor(person)).sites.some((site) => previewHost(site.devUrl) === host);
    if (who && (!who.github || who.owner || (await theirs(who)))) return c.body(null, 204);
    if (shareFits(readShareCookie(c.req.header("cookie")), host)) return c.body(null, 204);
    if (who) return c.text("That preview is not of a site you can open.", 403);
    // A share link: trade the token for a cookie at the studio, which can set one for the whole domain.
    const uri = c.req.header("x-forwarded-uri") ?? "/";
    const token =
      new URL(uri, "http://preview.invalid").searchParams.get("greatcms-share") ?? undefined;
    // A link that has run out says so, rather than asking a stranger for the studio's password.
    if (token && options.publicUrl && !shareFits(token, host)) {
      return c.redirect(`${options.publicUrl}/share`, 302);
    }
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
    const siteId = readShareToken(token, signingKey, shareRound);
    if (!token || !siteId || !next || next.startsWith("/")) {
      return c.html(shareProblemPage(), 403);
    }
    // A chat app unfurling the link gets a card about the preview, not a session or the site's contents.
    if (!c.req.query("open") && LINK_PREVIEWER.test(c.req.header("user-agent") ?? "")) {
      const open = new URLSearchParams({ token, next, open: "1" });
      return c.html(shareCard(store.getSite(siteId)?.name ?? "a site", `/share?${open}`));
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
    const token = createShareToken(signingKey, site.id, Date.now(), store.shareRound(site.id));
    url.searchParams.set("greatcms-share", token);
    const until = new Date(Number(token.split(".").at(-2))).toISOString();
    return c.html(sharePage({ site, url: url.href, until }));
  });

  /** Ends this site's preview links, and no other site's: the next link made starts a new round. */
  app.post("/sites/:id/share/stop", (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    store.stopSharing(site.id);
    const back = c.get("viewer").owner ? `/sites/${site.id}/settings` : `/sites/${site.id}`;
    return done(
      c,
      back,
      `Every preview link made for ${site.name} so far has stopped working. A new one works as usual.`,
    );
  });

  app.get("/:file{favicon\\.ico|favicon\\.svg|apple-touch-icon\\.png|greatcms-logo\\.png}", (c) => {
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
  const here = (c: Context<{ Variables: Variables }>, siteId: string, path: string) => {
    return store.presence({ siteId, path, actor: c.get("session"), name: c.get("viewer").name });
  };

  app.get("/sign-in", (c) => {
    const next = allowedNext(c.req.query("next")) ?? undefined;
    // Signed in here already, sent from the preview: renew its cookie rather than ask again.
    const session = readSession(c.req.header("cookie"), signingKey);
    if (viewerOf(session)) {
      if (next) signIn(c, session!.actor);
      return c.redirect(next ?? "/", 303);
    }
    return c.html(signInPage({ next, editors: hasEditors(), github: githubSignIn() }));
  });

  /** Sends the browser to GitHub to say who it is, remembering in a cookie that it was sent. */
  app.get("/sign-in/github", (c) => {
    if (!hub || !githubSignIn()) return c.notFound();
    const next = allowedNext(c.req.query("next")) ?? "";
    const { cookie, trip } = startGithubTrip(signingKey, next, isSecure(c));
    const url = hub.authorizeUrl(
      `${publicOrigin(c)}${SIGN_IN_CALLBACK}`,
      trip.state,
      trip.challenge,
    );
    if (!url) return c.notFound();
    c.header("Set-Cookie", cookie);
    return c.redirect(url, 302);
  });

  /** GitHub sent the browser back: who it is comes from GitHub itself, never from the address. */
  app.get(SIGN_IN_CALLBACK, async (c) => {
    if (!hub || !githubSignIn()) return c.notFound();
    const address = addressOf(c);
    const trip = readGithubTrip(c.req.header("cookie"), signingKey);
    const next = allowedNext(trip?.next) ?? undefined;
    const refuse = (error: string, status: 400 | 429 = 400) => {
      c.header("Set-Cookie", clearGithubTrip(isSecure(c)));
      return c.html(signInPage({ error, next, editors: hasEditors(), github: true }), status);
    };
    const limit = signInLimiter.check(`github:${address}`);
    if (!limit.allowed) {
      c.header("retry-after", String(limit.retryAfterSeconds));
      return refuse(
        `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
        429,
      );
    }
    const started =
      trip && sameText(c.req.query("state") ?? "", trip.state) && !store.isSessionRevoked(trip.id);
    if (!trip || !started) {
      return refuse(
        "That sign-in was not started in this browser, or it took too long. Start again.",
      );
    }
    // Good for one answer: the same address opened again signs nobody in.
    store.revokeSession(trip.id, trip.expiresAt);
    // Whatever GitHub says went wrong is its text in the address bar, so none of it is repeated.
    if (c.req.query("error")) return refuse("GitHub did not sign you in. Nothing was changed.");
    let person: GithubPerson;
    try {
      const found = await hub.identify(
        c.req.query("code") ?? "",
        `${publicOrigin(c)}${SIGN_IN_CALLBACK}`,
        trip.verifier,
      );
      person = store.saveGithubPerson({ ...found, name: found.name || found.login });
    } catch {
      return refuse("GitHub did not complete that sign-in. Start again.");
    }
    // A session this browser already carried is not kept alongside the new one.
    retire(c);
    signInLimiter.clear(`github:${address}`);
    signIn(c, `github:${person.id}`);
    c.header("Set-Cookie", clearGithubTrip(isSecure(c)), { append: true });
    const all = store.listSites();
    const sites = isGithubOwner(person) ? all : ((await access?.among(person, all)) ?? []);
    return c.redirect(next ?? (sites.length === 1 ? `/sites/${sites[0]!.id}` : "/"), 303);
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
    if (!editor) return c.redirect("/editors", 303);
    store.removeEditor(editor.id);
    return done(c, "/editors", `${editor.name} can no longer sign in.`);
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
      const ok = verifyPassword(supplied, editor?.passwordHash ?? dummyHash());
      if (editor && ok) actor = `editor:${editor.id}`;
    } else if (checkPassword(supplied, password)) {
      actor = "studio";
    }
    if (!actor) {
      // Deliberately vague, and the same shape whether or not a password was supplied: there is nothing to learn from it.
      return c.html(
        signInPage({
          error: "That did not work.",
          next,
          email,
          editors: hasEditors(),
          github: githubSignIn(),
        }),
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
    const sites = c.get("sites");
    const who = c.get("viewer");
    // Signed in, and GitHub lets them push to nothing here: said plainly, with the way out.
    if (who.github && !who.owner && sites.length === 0) {
      return c.html(noAccessPage({ name: who.name, login: who.github.login }));
    }
    return c.html(
      sitesPage(sites, store.countUnread(c.get("among")), undefined, await liveness.all(sites)),
    );
  });

  app.get("/inbox", (c) => {
    const siteId = c.req.query("site") || undefined;
    const includeSpam = c.req.query("spam") === "1";
    return c.html(
      inboxPage({
        submissions: store.listSubmissions({ siteId, among: c.get("among"), includeSpam }),
        sites: c.get("sites"),
        siteId: siteId && c.get("sites").some((site) => site.id === siteId) ? siteId : undefined,
        includeSpam,
      }),
    );
  });

  /** Whether a submission is one this person may act on: any, or one from a site they can open. */
  const inInbox = (c: Context<{ Variables: Variables }>, id: number) => {
    const among = c.get("among");
    if (!among) return true;
    const submission = store.getSubmission(id);
    return submission !== null && among.includes(submission.siteId);
  };

  app.get("/inbox.csv", (c) => {
    const siteId = c.req.query("site") || undefined;
    const rows = store.listSubmissions({
      siteId,
      among: c.get("among"),
      includeSpam: false,
      limit: 5000,
    });
    const names = new Map(c.get("sites").map((site) => [site.id, site.name]));
    const named = rows.map((row) =>
      Object.assign({ site: names.get(row.siteId) ?? row.siteId }, row),
    );
    return c.body(toCsv(named), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="submissions.csv"',
    });
  });

  app.post("/inbox/:id/read", async (c) => {
    const id = submissionId(c.req.param("id"));
    if (id === null || !inInbox(c, id)) return c.notFound();
    const form = await c.req.formData();
    const read = String(form.get("read") ?? "1") === "1";
    store.markRead(id, read);
    return done(c, inboxView(c, form), read ? "Marked as read." : "Marked as unread.");
  });

  app.post("/inbox/:id/delete", async (c) => {
    const id = submissionId(c.req.param("id"));
    if (id === null || !inInbox(c, id)) return c.notFound();
    store.deleteSubmission(id);
    // A bare POST still deletes; it just has no filter to go back to.
    const form = await c.req.formData().catch(() => new FormData());
    return done(c, inboxView(c, form), "The submission is deleted.");
  });

  /** The repositories the GitHub App reaches, and which are already here, for the connect page. */
  const githubRepositories = async (folders: Folder[]) => {
    const github = options.github;
    if (!github || !options.sitesRoot) return undefined;
    if (!github.config()) return { connected: false };
    const installUrl = github.installUrl() ?? undefined;
    try {
      const repositories = await github.repositories();
      // A folder is a repository's copy when its origin says so, whatever the folder is called.
      const origins = await Promise.all(folders.map((folder) => originOf(folder.path)));
      const copyOf = new Map(
        folders.flatMap((folder, index) => {
          const origin = origins[index];
          return origin ? [[sameRepository(origin), folder] as const] : [];
        }),
      );
      const names = new Set(folders.map((folder) => folder.name.toLowerCase()));
      return {
        connected: true,
        installUrl,
        repositories: repositories.map((repo) => {
          const copy = copyOf.get(sameRepository(repo.cloneUrl));
          return {
            fullName: repo.fullName,
            cloneUrl: repo.cloneUrl,
            private: repo.private,
            folder: names.has(repo.name.toLowerCase()) ? "" : repo.name,
            state: copy?.state ?? null,
            siteId: copy?.siteId,
          };
        }),
      };
    } catch (error) {
      return { connected: true, installUrl, error: describeError(error) };
    }
  };

  /** The connect page, with the sites folder's contents when there is one. */
  const connectPage = async (extra: Parameters<typeof newSitePage>[0] = {}) => {
    const folders = options.sitesRoot ? listFolders(options.sitesRoot, store.listSites()) : [];
    return newSitePage({
      sitesRoot: options.sitesRoot,
      folders,
      clones: clones?.list() ?? [],
      previewTemplate: options.previewUrl,
      gitAccess: Boolean(options.gitAccess || options.github),
      github: await githubRepositories(folders),
      ...extra,
    });
  };

  app.get("/sites/new", async (c) => c.html(await connectPage()));

  /**
   * Connects a folder that has a schema: checked by reading it, stored only if that works.
   * A folder without one gets the setup page instead of a dead end.
   */
  const connect = async (
    c: Context<{ Variables: Variables }>,
    values: { name: string; path: string; devUrl: string },
  ) => {
    // One folder, one site: a second connection would show the same content under two names.
    const existing = store.listSites().find((known) => known.path === values.path);
    if (existing) return c.redirect(`/sites/${existing.id}`, 303);
    const site: Site = {
      id: crypto.randomUUID(),
      name: values.name || nameFromFolder(basename(values.path)),
      path: values.path,
      devUrl:
        values.devUrl ||
        (previews ? previews.suggest(basename(values.path), store.listSites()) : ""),
      // Off until someone chooses where publishes go: pushing a default branch can put them live.
      pushAfterPublish: false,
      deployRoot: "",
      createdAt: new Date().toISOString(),
    };
    if (!hasSchema(site.path)) {
      return c.html(
        setupPage({
          path: site.path,
          values: { ...values, name: site.name },
          templates: TEMPLATES,
          error: `${site.path} has no .cms/schema.yaml.\n  fix: choose a starter below, or run \`greatcms init\` in that folder.`,
        }),
        422,
      );
    }
    try {
      await new SiteClient(site).context();
    } catch (error) {
      return c.html(await connectPage({ error: describeError(error), values }), 422);
    }
    store.addSite(site);
    sitesChanged();
    return done(c, `/sites/${site.id}`, `${site.name} is connected.`);
  };

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
        connectPage({
          error: "Nothing was connected: check the dev server URL.",
          fieldErrors: { devUrl: DEV_URL_ERROR },
          values,
        }),
        422,
      );
    }

    if (!values.path) {
      return c.html(await connectPage({ error: "Give the folder's path.", values }), 422);
    }
    const resolved = folderPath(values.path);
    const problem =
      "error" in resolved
        ? resolved.error
        : (await isDirectory(resolved.path))
          ? null
          : "There is no folder at this path on this machine.";
    if (problem || "error" in resolved) {
      return c.html(
        connectPage({
          error: "Nothing was connected: check the folder path.",
          fieldErrors: { path: problem ?? "" },
          values,
        }),
        422,
      );
    }
    return connect(c, { ...values, path: resolved.path });
  });

  app.get("/sites/setup", async (c) => {
    const typed = folderPath(c.req.query("path") ?? "");
    if ("error" in typed || !(await isDirectory(typed.path))) return c.redirect("/sites/new", 303);
    const path = typed.path;
    if (hasSchema(path)) return c.redirect("/sites/new", 303);
    return c.html(
      setupPage({ path, values: { name: nameFromFolder(basename(path)) }, templates: TEMPLATES }),
    );
  });

  /** Writes a starter schema and config from the same templates as `greatcms init`, as one commit. */
  app.post("/sites/setup", async (c) => {
    const form = await c.req.formData();
    const values = {
      path: String(form.get("path") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      devUrl: String(form.get("devUrl") ?? "").trim(),
      template: String(form.get("template") ?? ""),
    };
    const typed = folderPath(values.path);
    if ("error" in typed || !(await isDirectory(typed.path))) return c.redirect("/sites/new", 303);
    // One spelling of the folder, so the site is recognised as the folder it is listed under.
    values.path = typed.path;
    const again = (error: string) =>
      c.html(setupPage({ path: values.path, values, templates: TEMPLATES, error }), 422);
    if (values.devUrl && !isHttpUrl(values.devUrl)) return again(DEV_URL_ERROR);
    if (!TEMPLATES.some((template) => template.id === values.template)) {
      return again("Choose what to start with.");
    }
    if (!values.name) return again("The site needs a name.");
    if (hasSchema(values.path)) {
      return again(`${values.path} already has a .cms/schema.yaml: connect it instead.`);
    }

    let files: string[] = [];
    let packageJson: Record<string, never> | undefined;
    try {
      files = readdirSync(values.path);
      packageJson = JSON.parse(readFileSync(join(values.path, "package.json"), "utf8"));
    } catch {
      // No package.json: the starter falls back to a generic layout.
    }
    const plan = planStarter({
      name: values.name,
      template: values.template as TemplateId,
      files,
      packageJson,
    });
    try {
      await new LocalRepository(values.path).commitFiles({
        message: "Set up GreatCMS",
        files: plan.files.map((file) => ({ path: file.path, content: file.content })),
        author: authorOf(c.get("viewer")),
      });
    } catch (error) {
      return again(describeError(error));
    }
    return connect(c, values);
  });

  /** Copies a repository into the sites folder; the page shows it until it finishes. */
  app.post("/sites/clone", async (c) => {
    if (!clones || !options.sitesRoot) return c.notFound();
    const form = await c.req.formData();
    const cloneValues = {
      url: String(form.get("url") ?? "").trim(),
      branch: String(form.get("branch") ?? "").trim(),
      folder: String(form.get("folder") ?? "").trim(),
    };
    const again = async (cloneError: string) =>
      c.html(await connectPage({ error: "Nothing was copied.", cloneError, cloneValues }), 422);
    const urlProblem = cloneUrlProblem(cloneValues.url);
    if (urlProblem) return again(urlProblem);
    if (cloneValues.branch && !isBranchName(cloneValues.branch)) {
      return again("That branch name is not one Git accepts.");
    }
    const folder = cloneValues.folder || folderFromUrl(cloneValues.url);
    if (!isFolderName(folder)) {
      return again("Give a folder name of letters, digits, dots, dashes and underscores.");
    }
    const target = join(options.sitesRoot, folder);
    if (!isInside(options.sitesRoot, target) || existsSync(target)) {
      return again(`${target} already exists: choose another folder name.`);
    }
    const busy = clones.busy(folder);
    if (busy) return again(busy);
    if (
      !options.clonePrivate &&
      (await reachesPrivateNetwork(cloneValues.url, options.resolveHost))
    ) {
      return again(
        "That address is on this machine or its private network, which Copy from Git does not reach.\n  fix: start the studio with STUDIO_CLONE_PRIVATE=1 if your Git server lives there.",
      );
    }
    let config: Array<[string, string]> = [];
    try {
      config = (await options.github?.gitConfigFor(cloneValues.url)) ?? [];
    } catch (error) {
      return again(describeError(error));
    }
    // Asked again: another copy may have started while the address was being looked up.
    const taken = clones.busy(folder);
    if (taken) return again(taken);
    void clones.start(cloneValues.url, folder, cloneValues.branch, config);
    return c.redirect("/sites/new", 303);
  });

  const gitAccess = options.gitAccess;
  const github = options.github;
  /** What GitHub reports, or why it could not, for the pages that show it. */
  const githubState = async () => {
    if (!github?.config()) return { connected: false as const };
    try {
      return {
        connected: true as const,
        installations: await github.installations(),
        repositories: await github.repositories(),
      };
    } catch (error) {
      return { connected: true as const, error: describeError(error) };
    }
  };
  const gitAccessView = async (
    c: Context,
    extra: Partial<Parameters<typeof gitAccessPage>[0]> = {},
  ) =>
    gitAccessPage({
      tokens: gitAccess?.tokens() ?? [],
      github: github ? await githubView(publicOrigin(c)) : undefined,
      ...extra,
    });
  /** What the page is told about the app: its name and owner, never its key or secret. */
  const githubView = async (origin: string): Promise<GitHubView> => {
    const made = (github as GitHub).config();
    return {
      config: made ? { slug: made.slug, owner: made.owner, htmlUrl: made.htmlUrl } : null,
      installUrl: (github as GitHub).installUrl(),
      settingsUrl: (github as GitHub).settingsUrl(),
      state: await githubState(),
      signIn: {
        ready: githubSignIn(),
        callback: `${origin}${SIGN_IN_CALLBACK}`,
        owners: githubOwners(),
      },
    };
  };

  app.get("/git-access", async (c) =>
    gitAccess || github ? c.html(await gitAccessView(c)) : c.notFound(),
  );

  /** The page that sends the browser to GitHub with the app's manifest, ready to create. */
  app.post("/git-access/github", async (c) => {
    if (!github) return c.notFound();
    const form = await c.req.formData();
    const organization = String(form.get("organization") ?? "").trim();
    if (organization && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(organization)) {
      return c.html(
        await gitAccessView(c, {
          flash: { kind: "error", message: "That is not a GitHub organization name." },
        }),
        422,
      );
    }
    const { action, manifest } = github.creation(publicOrigin(c), organization || undefined);
    c.set("formTarget", new URL(action).origin);
    return c.html(githubCreatePage({ action, manifest, organization }));
  });

  app.get("/git-access/github/created", async (c) => {
    if (!github) return c.notFound();
    try {
      await github.finishCreation(c.req.query("code") ?? "", c.req.query("state") ?? "");
    } catch (error) {
      return c.html(
        await gitAccessView(c, { flash: { kind: "error", message: describeError(error) } }),
        400,
      );
    }
    // Straight on to choosing repositories: an app installed nowhere reaches nothing.
    return c.redirect(github.installUrl() ?? "/git-access", 303);
  });

  app.get("/git-access/github/installed", async (c) => {
    if (!github) return c.notFound();
    github.forget();
    access?.forget();
    if (c.req.query("setup_action") === "request") {
      return c.html(
        await gitAccessView(c, {
          flash: {
            kind: "success",
            message:
              "GitHub asked the organization's owners to approve the app. Its repositories appear here once they do.",
          },
        }),
      );
    }
    return done(c, "/sites/new#github", "GitHub is connected. Choose a repository to copy.");
  });

  /** For an app made before sign-in existed: the client secret its owner generated on GitHub. */
  app.post("/git-access/github/secret", async (c) => {
    if (!github || options.local) return c.notFound();
    const form = await c.req.formData();
    const problem = github.saveClientSecret(String(form.get("secret") ?? "").trim());
    return c.html(
      await gitAccessView(c, {
        flash: problem
          ? { kind: "error", message: `Nothing was saved. ${problem}` }
          : { kind: "success", message: "People can now sign in with GitHub." },
      }),
      problem ? 422 : 200,
    );
  });

  app.post("/git-access/github/refresh", (c) => {
    github?.forget();
    access?.forget();
    return done(
      c,
      c.req.header("referer")?.includes("/sites/new") ? "/sites/new#github" : "/git-access",
      "Asked GitHub again: this is what it reports now.",
    );
  });

  app.post("/git-access/github/delete", async (c) => {
    if (!github) return c.notFound();
    const settings = github.settingsUrl();
    await github.disconnect();
    // Everyone GitHub let in is signed out with it, wherever they are.
    store.clearGithubPeople();
    access?.forget();
    return c.html(
      await gitAccessView(c, {
        flash: {
          kind: "success",
          message: "GitHub is disconnected and the app is removed from every account.",
          detail: settings ? [`Delete the app itself on GitHub: ${settings}`] : undefined,
        },
      }),
    );
  });

  app.post("/git-access/token", async (c) => {
    if (!gitAccess) return c.notFound();
    const form = await c.req.formData();
    const host = String(form.get("host") ?? "");
    const problem = gitAccess.saveToken(
      host,
      String(form.get("username") ?? ""),
      String(form.get("token") ?? ""),
    );
    if (problem) {
      return c.html(
        gitAccessView(c, {
          host,
          tokenError: problem,
          flash: { kind: "error", message: "Nothing was saved." },
        }),
        422,
      );
    }
    return done(c, "/git-access", `The token for ${hostLabel(host)} is saved.`);
  });

  app.post("/git-access/token/delete", async (c) => {
    const form = await c.req.formData();
    const host = String(form.get("host") ?? "");
    gitAccess?.removeToken(host);
    return done(c, "/git-access", `The token for ${hostLabel(host)} is removed.`);
  });

  app.post("/sites/clone/dismiss", async (c) => {
    const form = await c.req.formData();
    clones?.dismiss(String(form.get("folder") ?? ""));
    return c.redirect("/sites/new", 303);
  });

  app.get("/sites/:id/settings", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    // A schema that no longer parses is exactly when settings matter: the page still opens.
    const schema = await new SiteClient(site)
      .context()
      .then((context) => context.schema)
      .catch(() => undefined);
    const branch = await new SiteClient(site).branchState().catch(() => null);
    return c.html(newSitePage({ editing: site, schema, branch }));
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
      branch: String(form.get("branch") ?? "").trim(),
      pushAfterPublish: form.get("pushAfterPublish") === "on" ? "on" : "",
    };
    const client = new SiteClient(site);
    const branch = await client.branchState().catch(() => null);
    if (values.deployRoot && !values.deployRoot.startsWith("/")) {
      return c.html(
        newSitePage({
          editing: site,
          values,
          branch,
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
          branch,
          error: "Nothing was saved: check the dev server URL.",
          fieldErrors: { devUrl: DEV_URL_ERROR },
        }),
        422,
      );
    }
    if (!values.name) {
      return c.html(
        newSitePage({ editing: site, values, branch, error: "The site needs a name." }),
        422,
      );
    }
    // A different branch first: if the folder cannot move, nothing else is saved either.
    if (values.branch && branch?.branch !== values.branch) {
      try {
        await client.switchBranch(values.branch);
      } catch (error) {
        return c.html(
          newSitePage({
            editing: site,
            values,
            branch,
            error: "Nothing was saved: the branch was not changed.",
            fieldErrors: { branch: describeError(error) },
          }),
          422,
        );
      }
    }
    store.updateSite(site.id, {
      name: values.name,
      devUrl: values.devUrl,
      pushAfterPublish: values.pushAfterPublish === "on",
      deployRoot: values.deployRoot,
    });
    sitesChanged();
    return done(c, `/sites/${site.id}`, "Settings saved.");
  });

  /**
   * "Publish later": the form is kept as submitted, and replayed through the ordinary publish
   * when it falls due, so validation, the conflict check and authorship are the same as now.
   */
  for (const base of ["/sites/:id/regions/:regionId", "/sites/:id/collections/:name/:slug"]) {
    app.post(base, async (c, next) => {
      const form = await c.req.formData();
      if (form.get("action") !== "schedule") return next();
      const site = store.getSite(c.req.param("id") ?? "");
      const target = contentOf(c);
      if (!site || !target || target.collection?.slug === "new") return c.notFound();
      const dueAt = zonedToEpoch(String(form.get("publishAt") ?? ""), timeZone);
      // The editor answers, so what was typed is still in the form.
      const refuse = (message: string) => {
        c.set("refused", message);
        return next();
      };
      if (dueAt === null || dueAt < Date.now() + 60_000) {
        return refuse("Nothing was scheduled: pick a time at least a minute from now.");
      }
      const entries: Array<[string, string]> = [];
      for (const [key, value] of form.entries()) {
        if (typeof value !== "string") {
          if (value.size > 0) {
            return refuse(
              "Nothing was scheduled: new images cannot wait. Publish them now, or schedule without them.",
            );
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
      return done(
        c,
        `/sites/${site.id}`,
        "Scheduled. It is listed under Scheduled until it publishes.",
      );
    });
  }

  app.post("/sites/:id/scheduled/:job/cancel", (c) => {
    const job = store.getScheduled(Number(c.req.param("job")));
    if (!job || job.siteId !== c.req.param("id")) return c.notFound();
    store.settleScheduled(job.id, "cancelled", `cancelled by ${c.get("actor")}`);
    return done(c, `/sites/${job.siteId}`, `The scheduled publish of ${job.label} is cancelled.`);
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
    return done(
      c,
      `/sites/${site.id}`,
      `Asked the builder to go back to ${sha.slice(0, 7)}. The live site changes once it has.`,
    );
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
    const [drafts, sync, branch, live, running, activity, counts] = await Promise.all([
      client.listLiveDrafts(context),
      client.syncState(),
      client.branchState().catch(() => null),
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
      branch,
      reviewUrl: branch ? reviewUrl(branch, options.github?.web) : undefined,
      live,
      scheduled: { jobs: store.listScheduled(site.id), timeZone, owner: ownerName },
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
    if (pushed.ok) return done(c, `/sites/${site.id}`, `Pushed to ${pushed.upstream}.`);

    try {
      return c.html(await renderSitePage(c, site, { kind: "error", message: pushed.reason }), 502);
    } catch (error) {
      return c.html(errorPage(site.name, describeError(error)), 502);
    }
  });

  app.post("/sites/:id/delete", (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.redirect("/", 303);
    store.removeSite(site.id);
    sitesChanged();
    return done(
      c,
      "/",
      `${site.name} is disconnected. Its folder and its content are as they were.`,
    );
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
      return done(
        c,
        `/sites/${site.id}/collections/${name}`,
        `Deleted “${entryTitle(context.schema.collections[name]!, entry.data, slug)}”.`,
      );
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

    const refused = c.get("refused");
    if (refused) {
      return c.html(
        renderEntry({
          slug: requested,
          document,
          errors: new Map(),
          headSha,
          flash: { kind: "error", message: refused },
        }),
        422,
      );
    }

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
            detail: issueLines(validation.issues),
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

      const flash = await publishedFlash(site, client, result.commitSha);
      // A new entry has an address of its own now: reloading or sharing `/new` would start another.
      if (requested === "new") {
        return done(
          c,
          `/sites/${site.id}/collections/${name}/${encodeURIComponent(slug)}`,
          flash.message,
          flash.kind,
        );
      }
      return c.html(
        renderEntry({
          slug,
          document,
          errors: new Map(),
          headSha: result.commitSha,
          flash,
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
    return done(c, `/sites/${site.id}/regions/${regionId}`, DISCARDED);
  });

  app.post("/sites/:id/collections/:name/:slug/draft/discard", async (c) => {
    const site = store.getSite(c.req.param("id"));
    if (!site) return c.notFound();
    const name = c.req.param("name");
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.notFound();

    const client = new SiteClient(site);
    await client.clearLiveDraft({ context: await client.context(), collection: { name, slug } });
    return done(c, `/sites/${site.id}/collections/${name}/${encodeURIComponent(slug)}`, DISCARDED);
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
      return done(
        c,
        `/sites/${site.id}/${target.back}`,
        `Version ${(c.req.param("sha") ?? "").slice(0, 7)} is in the form as unsaved edits. Publish to bring it back, or discard them to keep what is published.`,
      );
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

    const refused = c.get("refused");
    if (refused) {
      return c.html(
        renderRegion({
          document,
          errors: new Map(),
          headSha,
          flash: { kind: "error", message: refused },
        }),
        422,
      );
    }

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
            detail: issueLines(validation.issues),
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
      const response = await Promise.resolve(
        app.request(`/sites/${job.siteId}/${job.target}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      ).catch((error: unknown) => {
        // Settled whatever happens: a publish left "running" would never be tried or shown again.
        process.stderr.write(`scheduled publish ${job.id} failed: ${describeError(error)}\n`);
        return new Response(null, { status: 500 });
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
                : response.status === 404
                  ? "The person who scheduled it can no longer open this site."
                  : `The publish failed (${response.status}).`;
      store.settleScheduled(job.id, outcome ? "failed" : "published", outcome ?? undefined);
    }
  };

  /** Ends background work that would outlive the process: copies from Git still running. */
  const stop = () => clones?.stop();

  return Object.assign(app, { runDueSchedules, stop });
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

const DISCARDED = "Unsaved edits discarded. This is what is published.";

/** A host as someone typed it, short enough to repeat back. */
const hostLabel = (host: string) => host.trim().slice(0, 80) || "that host";

/** Compared against when an unknown email signs in, so the reply takes the same time. */
let dummy: string | undefined;
const dummyHash = () => (dummy ??= hashPassword(randomSecret()));

/** The studio asks a browser for none of these, and nothing it frames inherits them. */
const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()";

/**
 * Where a branch's publishes can be read and merged on GitHub: its comparison with the main
 * branch, which offers a pull request. Only for a branch of its own on a GitHub remote.
 */
export function reviewUrl(state: BranchState, web = "https://github.com"): string | undefined {
  const { branch, remoteUrl, defaultBranch } = state;
  if (!branch || !remoteUrl || branch === (defaultBranch ?? "main")) return undefined;
  const host = new URL(web).host.replace(/[.]/g, "\\.");
  const match =
    new RegExp(`^https?://(?:[^@/]+@)?${host}/([^/]+/[^/]+?)(?:\\.git)?/?$`, "i").exec(remoteUrl) ??
    new RegExp(`^(?:ssh://)?git@${host}[:/]([^/]+/[^/]+?)(?:\\.git)?/?$`, "i").exec(remoteUrl);
  if (!match) return undefined;
  const base = defaultBranch ? `${encodeURIComponent(defaultBranch)}...` : "";
  return `${web.replace(/\/+$/, "")}/${match[1]}/compare/${base}${encodeURIComponent(branch)}?expand=1`;
}

/** The password owner commits as git's configured identity; everyone else commits as themselves. */
function authorOf(who: Viewer): Author | undefined {
  if (who.github) return { name: who.name, email: who.github.email };
  return who.owner || !who.email ? undefined : { name: who.name, email: who.email };
}

/** The commit the form was loaded at, which a draft remembers as where it began. */
function baseOf(entries: Array<[string, string]>): string | undefined {
  const sha = entries.find(([key]) => key === "headSha")?.[1];
  return sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
}

/** The inbox as it was filtered when a submission in it was acted on. */
function inboxView(c: Context<{ Variables: Variables }>, form: FormData): string {
  const query = new URLSearchParams();
  const siteId = String(form.get("site") ?? "");
  if (c.get("sites").some((site) => site.id === siteId)) query.set("site", siteId);
  if (form.get("spam") === "1") query.set("spam", "1");
  return query.size > 0 ? `/inbox?${query}` : "/inbox";
}

/** The host a site's preview is served on, or null when it has none. */
function previewHost(devUrl: string): string | null {
  try {
    return new URL(devUrl).host;
  } catch {
    return null;
  }
}

/** Programs that fetch a pasted link to draw a card for it. */
const LINK_PREVIEWER =
  /bot\b|crawler|spider|facebookexternalhit|WhatsApp\/|SkypeUriPreview|Iframely|Embedly/i;

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
    html`<div class="page-head"><h1>${title}</h1></div>
      <p><a class="button secondary" href="/">Back to sites</a></p>`,
  );
}

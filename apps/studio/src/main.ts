/** Entry point. */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { randomSecret } from "./auth.js";
import { applySites, parseSites, withoutSecrets } from "./config.js";
import { warmAssets } from "./assets.js";
import { PreviewAddresses, sweepStaleClones } from "./connect.js";
import { publishesSettled } from "./repo.js";
import { describeFailure, shutDown } from "./shutdown.js";
import { GitAccess } from "./git-access.js";
import { GitHub } from "./github.js";
import { dirname, join } from "node:path";
import { Store } from "./db.js";
import { isHttpUrl } from "./http.js";
import { type Notifier, Notifiers, ResendNotifier, WebhookNotifier } from "./submissions.js";
import { setLocale } from "./views/locale.js";

const password = process.env.STUDIO_PASSWORD;
if (!password) {
  process.stderr.write(
    "STUDIO_PASSWORD is not set.\n  fix: STUDIO_PASSWORD=... pnpm start (use a long random value)\n",
  );
  process.exit(1);
}

// A generated secret is fine for a single instance; set STUDIO_SECRET to keep sessions.
const secret = process.env.STUDIO_SECRET ?? randomSecret();
const databaseFile = process.env.STUDIO_DB ?? "data/studio.sqlite";
const port = Number(process.env.PORT ?? 8787);

// Each notifier is optional and independent: email for submissions, a webhook for everything.
const configured: Notifier[] = [];
if (process.env.RESEND_API_KEY && process.env.NOTIFY_FROM && process.env.NOTIFY_TO) {
  configured.push(
    new ResendNotifier({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.NOTIFY_FROM,
      to: process.env.NOTIFY_TO,
    }),
  );
}
if (process.env.STUDIO_WEBHOOK_URL) {
  if (!isHttpUrl(process.env.STUDIO_WEBHOOK_URL)) {
    process.stderr.write("STUDIO_WEBHOOK_URL must be an http:// or https:// URL.\n");
    process.exit(1);
  }
  configured.push(new WebhookNotifier(process.env.STUDIO_WEBHOOK_URL));
}
const notifier = configured.length > 0 ? new Notifiers(configured) : undefined;

// Only behind a proxy you control: the headers it sets are otherwise the visitor's to forge.
const trustProxy =
  process.env.STUDIO_TRUST_PROXY === "cloudflare"
    ? "cloudflare"
    : process.env.STUDIO_TRUST_PROXY === "1";

// What language the studio's own screens use for dates; content keeps the language its schema says.
setLocale(process.env.STUDIO_LOCALE ?? "en");

// A mistyped preview template stops the start, rather than giving every new site a broken address.
try {
  if (process.env.STUDIO_PREVIEW_URL) void new PreviewAddresses(process.env.STUDIO_PREVIEW_URL);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

const emailed = Boolean(process.env.RESEND_API_KEY);
const hooked = Boolean(process.env.STUDIO_WEBHOOK_URL);
const sessionsKept = Boolean(process.env.STUDIO_SECRET);
// Read above and held in memory: every git this process starts would otherwise inherit them.
withoutSecrets(process.env);

const store = new Store(databaseFile);
// A publish the last run had taken but not finished is tried again rather than left hanging.
const recovered = store.recoverScheduled();
// Copies a stopped studio left half-made would block the same name from being copied again.
const swept = process.env.STUDIO_SITES_ROOT ? sweepStaleClones(process.env.STUDIO_SITES_ROOT) : [];

// An inbox is not an archive: with STUDIO_SUBMISSION_DAYS set, older submissions are deleted.
const retentionDays = Number(process.env.STUDIO_SUBMISSION_DAYS ?? 0);
if (retentionDays > 0) {
  const prune = () => store.pruneSubmissions(retentionDays);
  prune();
  setInterval(prune, 6 * 60 * 60_000).unref();
}
// Sites a server is told about up front, so it comes up managing them under ids that never change.
const sites = process.env.STUDIO_SITES ? parseSites(process.env.STUDIO_SITES) : [];
const declared = applySites(store, sites);
const app = createApp({
  store,
  password,
  secret,
  notifier,
  trustProxy,
  publicUrl: process.env.STUDIO_URL?.replace(/\/$/, "") || undefined,
  cookieDomain: process.env.STUDIO_COOKIE_DOMAIN || undefined,
  probeUrls: new Map(sites.filter((site) => site.probeUrl).map((site) => [site.id, site.probeUrl])),
  sitesRoot: process.env.STUDIO_SITES_ROOT || undefined,
  previewUrl: process.env.STUDIO_PREVIEW_URL || undefined,
  previewsFile: process.env.STUDIO_PREVIEWS_FILE || undefined,
  previewProbe: process.env.STUDIO_PREVIEW_PROBE || undefined,
  clonePrivate: process.env.STUDIO_CLONE_PRIVATE === "1",
  // Beside the database, so a container keeps its GitHub App and tokens in the same volume.
  gitAccess: new GitAccess(join(dirname(databaseFile), "git")),
  githubOwners: process.env.STUDIO_GITHUB_OWNERS?.split(","),
  ownerName: process.env.STUDIO_OWNER_NAME,
  github: new GitHub(
    join(dirname(databaseFile), "git", "github-app.json"),
    process.env.STUDIO_GITHUB_URL || undefined,
  ),
});

// Publishes scheduled for later go out within half a minute of their time, one run at a time.
let publishingDue = false;
setInterval(() => {
  if (publishingDue) return;
  publishingDue = true;
  app
    .runDueSchedules()
    .catch((error: unknown) =>
      process.stderr.write(`scheduled publishes: ${describeFailure(error)}\n`),
    )
    .finally(() => (publishingDue = false));
}, 30_000).unref();

const server = serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`GreatCMS studio on http://localhost:${info.port}\n`);
  process.stdout.write(`  database: ${databaseFile}\n`);
  for (const line of declared) process.stdout.write(`  site ${line}\n`);
  if (process.env.STUDIO_SITES_ROOT) {
    process.stdout.write(`  sites folder: ${process.env.STUDIO_SITES_ROOT}\n`);
  }
  if (process.env.STUDIO_PREVIEW_URL) {
    process.stdout.write(`  previews: ${process.env.STUDIO_PREVIEW_URL}\n`);
  }
  process.stdout.write(
    emailed
      ? "  submissions: stored and emailed\n"
      : "  submissions: stored (set RESEND_API_KEY, NOTIFY_FROM, NOTIFY_TO to email them)\n",
  );
  if (hooked) process.stdout.write("  webhook: submissions and publishes\n");
  if (retentionDays) process.stdout.write(`  submissions kept ${retentionDays} days\n`);
  if (recovered) process.stdout.write(`  scheduled publishes picked up again: ${recovered}\n`);
  for (const name of swept) process.stdout.write(`  removed an unfinished copy: ${name}\n`);
  if (!sessionsKept) {
    process.stdout.write("  sessions reset on restart (set STUDIO_SECRET to persist them)\n");
  }
});

// A proxy keeps connections open for about a minute; closing them sooner races its next request.
const http = server as unknown as { keepAliveTimeout: number; headersTimeout: number };
http.keepAliveTimeout = 65_000;
http.headersTimeout = 66_000;

// The first editor page should not wait behind compressing the bundles.
void warmAssets().catch(() => undefined);

let stopping = false;
const stop = (code?: number) => {
  // Asked twice, it stops at once.
  if (stopping) process.exit(code ?? 1);
  stopping = true;
  void shutDown({
    server,
    settled: publishesSettled,
    close: () => {
      app.stop();
      store.close();
    },
    log: (line) => process.stderr.write(`${line}\n`),
  }).then((result) => process.exit(code ?? result));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop());

// One request's stray failure is logged, not allowed to take every editor's session down with it.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`unhandled rejection: ${describeFailure(reason)}\n`);
});
// After this nothing can be trusted to be in a known state: finish publishes, then stop.
process.on("uncaughtException", (error) => {
  process.stderr.write(`uncaught exception: ${describeFailure(error)}\n`);
  stop(1);
});

/** Entry point. */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { randomSecret } from "./auth.js";
import { applySites, parseSites } from "./config.js";
import { Store } from "./db.js";
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
if (process.env.STUDIO_WEBHOOK_URL)
  configured.push(new WebhookNotifier(process.env.STUDIO_WEBHOOK_URL));
const notifier = configured.length > 0 ? new Notifiers(configured) : undefined;

// Only behind a proxy you control: the headers it sets are otherwise the visitor's to forge.
const trustProxy =
  process.env.STUDIO_TRUST_PROXY === "cloudflare"
    ? "cloudflare"
    : process.env.STUDIO_TRUST_PROXY === "1";

// What language the studio's own screens use for dates; content keeps the language its schema says.
setLocale(process.env.STUDIO_LOCALE ?? "en");

const store = new Store(databaseFile);

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
});

// Publishes scheduled for later go out within half a minute of their time.
setInterval(() => void app.runDueSchedules(), 30_000).unref();

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`GreatCMS studio on http://localhost:${info.port}\n`);
  process.stdout.write(`  database: ${databaseFile}\n`);
  for (const line of declared) process.stdout.write(`  site ${line}\n`);
  process.stdout.write(
    process.env.RESEND_API_KEY
      ? "  submissions: stored and emailed\n"
      : "  submissions: stored (set RESEND_API_KEY, NOTIFY_FROM, NOTIFY_TO to email them)\n",
  );
  if (process.env.STUDIO_WEBHOOK_URL)
    process.stdout.write("  webhook: submissions and publishes\n");
  if (retentionDays) process.stdout.write(`  submissions kept ${retentionDays} days\n`);
  if (!process.env.STUDIO_SECRET) {
    process.stdout.write("  sessions reset on restart (set STUDIO_SECRET to persist them)\n");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    store.close();
    process.exit(0);
  });
}

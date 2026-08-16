/** Entry point. */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { randomSecret } from "./auth.js";
import { Store } from "./db.js";
import { ResendNotifier } from "./submissions.js";

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

// Email is optional.
const notifier =
  process.env.RESEND_API_KEY && process.env.NOTIFY_FROM && process.env.NOTIFY_TO
    ? new ResendNotifier({
        apiKey: process.env.RESEND_API_KEY,
        from: process.env.NOTIFY_FROM,
        to: process.env.NOTIFY_TO,
      })
    : undefined;

// Only behind a proxy you control: the headers it sets are otherwise the visitor's to forge.
const trustProxy = process.env.STUDIO_TRUST_PROXY === "1";

const store = new Store(databaseFile);
const app = createApp({ store, password, secret, notifier, trustProxy });

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`GreatCMS studio on http://localhost:${info.port}\n`);
  process.stdout.write(`  database: ${databaseFile}\n`);
  process.stdout.write(
    notifier
      ? "  submissions: stored and emailed\n"
      : "  submissions: stored (set RESEND_API_KEY, NOTIFY_FROM, NOTIFY_TO to email them)\n",
  );
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

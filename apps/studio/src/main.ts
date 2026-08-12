/**
 * Entry point. One process, one SQLite file, no external services.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { randomSecret } from "./auth.js";
import { Store } from "./db.js";

const password = process.env.STUDIO_PASSWORD;
if (!password) {
  process.stderr.write(
    "STUDIO_PASSWORD is not set.\n  fix: STUDIO_PASSWORD=... pnpm start (use a long random value)\n",
  );
  process.exit(1);
}

// A generated secret is fine for a single instance; set STUDIO_SECRET to keep
// sessions alive across restarts or to run more than one process.
const secret = process.env.STUDIO_SECRET ?? randomSecret();
const databaseFile = process.env.STUDIO_DB ?? "data/studio.sqlite";
const port = Number(process.env.PORT ?? 8787);

const store = new Store(databaseFile);
const app = createApp({ store, password, secret });

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`GreatCMS studio on http://localhost:${info.port}\n`);
  process.stdout.write(`  database: ${databaseFile}\n`);
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

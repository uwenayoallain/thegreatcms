/** Entry point. */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { randomSecret } from "./auth.js";
import { Store } from "./db.js";
import { ResendNotifier } from "./submissions.js";
import { ModelSummarizer } from "./summarize.js";

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

// Any OpenAI-compatible endpoint: Groq, Google, Cloudflare, Mistral, Ollama.
const summarizer =
  process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL
    ? new ModelSummarizer({
        baseUrl: process.env.AI_BASE_URL,
        apiKey: process.env.AI_API_KEY,
        model: process.env.AI_MODEL,
        onError: (message) => process.stderr.write(`${message}\n`),
      })
    : undefined;

const store = new Store(databaseFile);
const app = createApp({ store, password, secret, notifier, summarizer });

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`GreatCMS studio on http://localhost:${info.port}\n`);
  process.stdout.write(`  database: ${databaseFile}\n`);
  process.stdout.write(
    notifier
      ? "  submissions: stored and emailed\n"
      : "  submissions: stored (set RESEND_API_KEY, NOTIFY_FROM, NOTIFY_TO to email them)\n",
  );
  process.stdout.write(
    summarizer
      ? `  pull request titles: ${process.env.AI_MODEL} (per-site opt-in)\n`
      : "  pull request titles: generated from the diff (set AI_BASE_URL, AI_API_KEY, AI_MODEL for model-written ones)\n",
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

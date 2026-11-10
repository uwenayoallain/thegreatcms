/** The dynamic layer: the one thing Git cannot hold. */

import { isHttpUrl } from "./http.js";

export const SPAM_THRESHOLD = 3;

/** Fields that are machinery rather than content the author typed. */
const RESERVED = new Set(["_redirect", "_form", "_t", "company"]);

export interface SpamAssessment {
  score: number;
  reasons: string[];
}

export function assessSpam(
  fields: Record<string, string>,
  options: { now?: number } = {},
): SpamAssessment {
  const reasons: string[] = [];
  let score = 0;

  // A honeypot field is invisible and off the tab order, so only a bot fills it.
  if ((fields.company ?? "").trim() !== "") {
    score += 5;
    reasons.push("hidden honeypot field was filled in");
  }

  // Forms rendered and submitted within a second were not typed by a person.
  const started = Number(fields._t);
  if (Number.isFinite(started) && started > 0) {
    const elapsed = (options.now ?? Date.now()) - started;
    if (elapsed < 1200) {
      score += 3;
      reasons.push("submitted less than a second after the page loaded");
    }
  }

  const body = Object.entries(fields)
    .filter(([key]) => !RESERVED.has(key))
    .map(([, value]) => value)
    .join(" ");

  const links = body.match(/https?:\/\//g)?.length ?? 0;
  if (links >= 4) {
    score += 2;
    reasons.push(`${links} links in the message`);
  }

  if (body.trim() === "") {
    score += 2;
    reasons.push("every field was empty");
  }

  return { score, reasons };
}

/** Content fields, with machinery stripped out. */
export function contentFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED.has(key) || key.startsWith("_")) continue;
    out[key] = value;
  }
  return out;
}

/** A fixed-window rate limiter held in memory. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    entry.count += 1;
    if (entry.count > this.limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Forgets a key, so a correct password does not leave failures counting against you. */
  clear(key: string): void {
    this.hits.delete(key);
  }

  /** Expired buckets are dropped opportunistically so the map cannot grow forever. */
  private sweep(now: number): void {
    if (this.hits.size < 5000) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}

export interface Notification {
  /** What happened: a visitor's form arrived, or someone published. */
  kind?: "submission" | "publish";
  subject: string;
  lines: string[];
  /** For a submission: the site's name, the form's, and what the visitor sent, field by field. */
  site?: string;
  form?: string;
  fields?: Record<string, string>;
  /** The visitor's own address, when the form asked for one, so a reply goes to them. */
  replyTo?: string;
  /** Where the submission can be read in the studio. */
  inbox?: string;
}

const ADDRESS = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;

/** The one address a visitor gave in a field named for it; anything else is not a place to reply to. */
export function replyAddress(fields: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(fields)) {
    if (!/^e-?mail$/i.test(key.trim())) continue;
    const address = value.trim();
    if (address.length <= 254 && ADDRESS.test(address)) return address;
  }
  return undefined;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** A submission as an email reads it: each field under its name, long answers keeping their lines. */
export function submissionHtml(message: Notification): string {
  const rows = Object.entries(message.fields ?? {})
    .map(
      ([key, value]) =>
        `<tr><th align="left" valign="top" style="padding:4px 16px 4px 0;font-weight:600">${escapeHtml(key)}</th><td style="padding:4px 0;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const inbox = message.inbox
    ? `<p style="margin:16px 0 0;color:#5d6168">Read it in the studio: <a href="${escapeHtml(message.inbox)}">${escapeHtml(message.inbox)}</a></p>`
    : "";
  return `<div style="font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#16181b"><p style="margin:0 0 12px">${escapeHtml(message.subject)}</p><table cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>${inbox}</div>`;
}

export interface Notifier {
  notify(message: Notification): Promise<void>;
}

/** Every configured notifier, each told independently, so one failing never silences another. */
export class Notifiers implements Notifier {
  constructor(private readonly list: Notifier[]) {}

  get size(): number {
    return this.list.length;
  }

  async notify(message: Notification): Promise<void> {
    await Promise.allSettled(this.list.map((notifier) => notifier.notify(message)));
  }
}

/**
 * A JSON POST to any URL. Slack and Discord incoming webhooks read `text` and `content`; anything
 * else gets the structured fields beside them.
 */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async notify(message: Notification): Promise<void> {
    if (!isHttpUrl(this.url)) {
      process.stderr.write(
        "webhook skipped: STUDIO_WEBHOOK_URL must be an http:// or https:// URL\n",
      );
      return;
    }
    const text = [message.subject, ...message.lines].join("\n");
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Discord refuses `content` over 2000 characters; the whole of it is in `lines` and `fields`.
        body: JSON.stringify({ text, content: text.slice(0, 2000), ...message }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) process.stderr.write(`webhook failed: ${response.status}\n`);
    } catch (error) {
      process.stderr.write(`webhook failed: ${(error as Error).message}\n`);
    }
  }
}

/** Email notifications via Resend. */
export class ResendNotifier implements Notifier {
  constructor(
    private readonly options: { apiKey: string; from: string; to: string },
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async notify(message: Notification): Promise<void> {
    // Email is for what visitors send; publishes are already in Git and the webhook.
    if (message.kind === "publish") return;
    try {
      const response = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.options.from,
          to: this.options.to,
          subject: message.subject.replace(/\s+/g, " ").slice(0, 200),
          text: [
            ...message.lines,
            ...(message.inbox ? ["", `Read it in the studio: ${message.inbox}`] : []),
          ].join("\n"),
          ...(message.fields ? { html: submissionHtml(message) } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
      });
      if (!response.ok) {
        process.stderr.write(`notification failed: Resend returned ${response.status}\n`);
      }
    } catch (error) {
      process.stderr.write(`notification failed: ${(error as Error).message}\n`);
    }
  }
}

export function toCsv(
  rows: Array<{ createdAt: string; form: string; site?: string; data: Record<string, string> }>,
): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row.data)))].toSorted();
  const sites = rows.some((row) => row.site !== undefined);
  // The fixed columns say what they are; a visitor's field named the same stays apart from them.
  const header = ["Received (UTC)", ...(sites ? ["Site"] : []), "Form", ...columns];
  const lines = [header.map(csvCell).join(",")];

  for (const row of rows) {
    lines.push(
      [
        utc(row.createdAt),
        ...(sites ? [row.site ?? ""] : []),
        row.form,
        ...columns.map((column) => row.data[column] ?? ""),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // CRLF is what the format asks for, and what spreadsheets expect inside a quoted cell's row.
  return `${lines.join("\r\n")}\r\n`;
}

/** SQLite's `2026-11-10 00:01:35` as the same instant, said unambiguously. */
function utc(stored: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stored)
    ? `${stored.replace(" ", "T")}Z`
    : stored;
}

function csvCell(value: string): string {
  // A leading =, +, -, or @ makes a spreadsheet treat the cell as a formula.
  const guarded = /^\s*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Naming a pull request. */

import type { RegionDocument } from "@greatcms/spec";

export interface Change {
  /** Dotted field path, e.g. `seo.title` or `blocks[2].heading`. */
  path: string;
  kind: "added" | "changed" | "removed";
  before?: string;
  after?: string;
}

export interface Summary {
  title: string;
  body: string;
  /** True when a model wrote the title, so the UI can be honest about it. */
  fromModel: boolean;
}

/** Field-level diff between the published document and the one being proposed. */
export function diffDocuments(
  before: RegionDocument | null,
  after: RegionDocument,
  basePath = "",
): Change[] {
  const changes: Change[] = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);

  for (const key of [...keys].toSorted()) {
    if (key.startsWith("_")) continue;

    const path = basePath ? `${basePath}.${key}` : key;
    const from = (before ?? {})[key];
    const to = after[key];

    if (isPlainObject(from) && isPlainObject(to)) {
      changes.push(...diffDocuments(from, to, path));
      continue;
    }
    if (Array.isArray(from) || Array.isArray(to)) {
      const fromList = Array.isArray(from) ? from : [];
      const toList = Array.isArray(to) ? to : [];
      if (fromList.length !== toList.length) {
        changes.push({
          path,
          kind: "changed",
          before: `${fromList.length} item${fromList.length === 1 ? "" : "s"}`,
          after: `${toList.length} item${toList.length === 1 ? "" : "s"}`,
        });
      } else if (JSON.stringify(fromList) !== JSON.stringify(toList)) {
        changes.push({ path, kind: "changed" });
      }
      continue;
    }

    const fromText = display(from);
    const toText = display(to);
    if (fromText === toText) continue;

    if (fromText === "") changes.push({ path, kind: "added", after: toText });
    else if (toText === "") changes.push({ path, kind: "removed", before: fromText });
    else changes.push({ path, kind: "changed", before: fromText, after: toText });
  }

  return changes;
}

export interface SummaryContext {
  siteName: string;
  regionId: string;
  regionLabel: string;
  changes: Change[];
}

/** Always correct, never interesting. Generated purely from the diff. */
export function deterministicSummary(context: SummaryContext): Summary {
  const { siteName, regionLabel, regionId, changes } = context;
  const count = changes.length;

  const title =
    count === 0
      ? `Republish ${regionLabel} on ${siteName}`
      : count === 1 && changes[0]
        ? `Update ${changes[0].path} in ${regionLabel} on ${siteName}`
        : `Update ${regionLabel} on ${siteName} (${count} fields)`;

  const lines = [`Content change to \`${regionId}\`, published from the GreatCMS studio.`, ""];

  if (count > 0) {
    lines.push("| Field | Change |", "| --- | --- |");
    for (const change of changes) {
      lines.push(`| \`${change.path}\` | ${describeChange(change)} |`);
    }
    lines.push("");
  }

  lines.push("Merging this publishes the change; your deploy pipeline takes it from there.");

  return { title: clampTitle(title), body: lines.join("\n"), fromModel: false };
}

function describeChange(change: Change): string {
  switch (change.kind) {
    case "added":
      return `added — ${truncate(change.after ?? "")}`;
    case "removed":
      return `removed (was ${truncate(change.before ?? "")})`;
    default:
      return change.before && change.after
        ? `${truncate(change.before)} → ${truncate(change.after)}`
        : "changed";
  }
}

export interface Summarizer {
  summarize(context: SummaryContext): Promise<Summary>;
}

export interface ModelSummarizerOptions {
  /** Any OpenAI-compatible endpoint, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Publishing must not stall behind a model. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  onError?: (message: string) => void;
}

export class ModelSummarizer implements Summarizer {
  constructor(private readonly options: ModelSummarizerOptions) {}

  async summarize(context: SummaryContext): Promise<Summary> {
    const fallback = deterministicSummary(context);
    const { baseUrl, apiKey, model, timeoutMs = 6000, onError } = this.options;
    const fetchImpl = this.options.fetch ?? globalThis.fetch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 200,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt(context) },
          ],
        }),
      });

      if (!response.ok) {
        onError?.(`summariser: model returned ${response.status}`);
        return fallback;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) {
        onError?.("summariser: model returned nothing usable");
        return fallback;
      }

      const title = clampTitle(firstLine(text));
      if (!title) return fallback;

      // The model writes the headline; the diff table stays machine-generated, because a reviewer needs.
      return { title, body: fallback.body, fromModel: true };
    } catch (error) {
      const reason =
        (error as Error).name === "AbortError" ? "timed out" : (error as Error).message;
      onError?.(`summariser: ${reason}`);
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Used when no model is configured. */
export const deterministicSummarizer: Summarizer = {
  async summarize(context) {
    return deterministicSummary(context);
  },
};

const SYSTEM_PROMPT = [
  "You write pull request titles for website content changes.",
  "Reply with the title only: one line, under 70 characters, no quotes, no trailing period.",
  "Describe what changed on the page in plain language a non-developer would use.",
  "Never invent changes that are not listed.",
].join(" ");

function userPrompt(context: SummaryContext): string {
  const lines = [
    `Site: ${context.siteName}`,
    `Section: ${context.regionLabel} (${context.regionId})`,
    "Changes:",
  ];
  for (const change of context.changes.slice(0, 20)) {
    lines.push(`- ${change.path}: ${describeChange(change)}`);
  }
  if (context.changes.length === 0) lines.push("- no field values changed");
  return lines.join("\n");
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "")
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/\.$/, "");
}

function clampTitle(title: string): string {
  const single = title.replace(/\s+/g, " ").trim();
  return single.length > 72 ? `${single.slice(0, 69).trimEnd()}…` : single;
}

function truncate(value: string, max = 60): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is RegionDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

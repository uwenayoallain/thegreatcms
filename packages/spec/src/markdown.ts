/** Collection entries are Markdown with YAML frontmatter, because that is what Hugo, Jekyll, Eleventy. */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(source: string, file = "entry.md"): Frontmatter {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return { data: {}, body: source };

  const [, yaml = "", body = ""] = match;
  let data: unknown;
  try {
    data = parseYaml(yaml) ?? {};
  } catch (err) {
    throw new Error(`${file}: frontmatter is not valid YAML — ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${file}: frontmatter must be a mapping of keys to values.`);
  }
  return { data: data as Record<string, unknown>, body };
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) clean[key] = value;
  }
  const yaml = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
  const text = body.trimEnd();
  return `---\n${yaml}\n---\n\n${text}\n`;
}

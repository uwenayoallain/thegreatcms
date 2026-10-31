/** Collection entries are Markdown with YAML frontmatter, because that is what Hugo, Jekyll, Eleventy and Astro already read. */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * The first line is exactly `---`, and the frontmatter ends at the next line that is
 * exactly `---` (a trailing CR allowed on either). Everything after that line is the
 * body, verbatim. Without both fences the whole file is body.
 */
function splitFrontmatter(source: string): { yaml: string; body: string } | null {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const lines = text.split("\n");
  if (!isFence(lines[0])) return null;
  const close = lines.findIndex((line, index) => index > 0 && isFence(line));
  if (close === -1) return null;
  const yaml = lines.slice(1, close).map((line) => line.replace(/\r$/, ""));
  return { yaml: yaml.join("\n"), body: lines.slice(close + 1).join("\n") };
}

function isFence(line: string | undefined): boolean {
  return line?.replace(/\r$/, "") === "---";
}

export function parseFrontmatter(source: string, file = "entry.md"): Frontmatter {
  const parts = splitFrontmatter(source);
  if (!parts) return { data: {}, body: source };

  const { yaml, body } = parts;
  let data: unknown;
  try {
    data = parseYaml(yaml) ?? {};
  } catch (err) {
    throw new Error(`${file}: frontmatter is not valid YAML: ${(err as Error).message}`, {
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

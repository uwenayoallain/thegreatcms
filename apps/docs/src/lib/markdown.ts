/** Markdown → HTML with linkable headings, and the outline a page needs for "On this page". */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked, type Tokens } from "marked";
import { type BundledLanguage, createHighlighter, type Highlighter } from "shiki";

export interface Heading {
  depth: number;
  id: string;
  text: string;
}

export interface Rendered {
  html: string;
  headings: Heading[];
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LANGS: BundledLanguage[] = [
  "sh",
  "bash",
  "yaml",
  "json",
  "js",
  "ts",
  "html",
  "astro",
  "markdown",
  "mdx",
];

/**
 * A theme's colours become a handful of semantic classes, so highlighting costs a few
 * CSS rules rather than inline styles, and follows the site's own light and dark palettes.
 */
const CLASS_FOR: Record<string, string> = {
  "#d73a49": "tk-kw", // keywords
  "#22863a": "tk-tag", // tags, YAML keys
  "#032f62": "tk-str", // strings, shell words
  "#005cc5": "tk-con", // constants, numbers, flags, attribute names
  "#6f42c1": "tk-fn", // functions, commands
  "#e36209": "tk-var", // variables, parameters
  "#6a737d": "tk-com", // comments
};

/** A WebP's pixel size from its header, so every image is sized before it loads and nothing shifts. */
export function webpSize(bytes: Buffer): { width: number; height: number } {
  const chunk = bytes.toString("ascii", 12, 16);
  if (bytes.toString("ascii", 8, 12) === "WEBP") {
    if (chunk === "VP8 ") {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
  }
  throw new Error("Docs images are WebP, so the build can size them.");
}

let highlighter: Promise<Highlighter> | undefined;

/** Highlights one block; an unknown language is returned escaped and unstyled. */
export async function highlight(code: string, lang: string): Promise<string> {
  const language = (lang === "njk" ? "html" : lang) as BundledLanguage;
  if (!LANGS.includes(language)) return escape(code);
  highlighter ??= createHighlighter({ themes: ["github-light"], langs: LANGS });
  const lines = (await highlighter).codeToTokensBase(code, {
    lang: language,
    theme: "github-light",
  });
  return lines
    .map((line) => {
      let out = "";
      let open: string | undefined;
      for (const token of line) {
        const cls = CLASS_FOR[token.color?.toLowerCase() ?? ""];
        if (cls !== open) {
          if (open) out += "</span>";
          if (cls) out += `<span class="${cls}">`;
          open = cls;
        }
        out += escape(token.content);
      }
      if (open) out += "</span>";
      return out;
    })
    .join("\n");
}

export async function renderMarkdown(source: string): Promise<Rendered> {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();

  const blocks: Array<{ placeholder: string; html: Promise<string> }> = [];
  const marked = new Marked({
    renderer: {
      code({ text, lang }: Tokens.Code) {
        const placeholder = `\u0000code${blocks.length}\u0000`;
        const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        blocks.push({
          placeholder,
          html: highlight(text, language).then(
            (inner) =>
              `<pre tabindex="0"><code${language ? ` class="language-${escape(language)}"` : ""}>${inner}</code></pre>\n`,
          ),
        });
        return placeholder;
      },
      image({ href, text }: Tokens.Image) {
        if (!href.startsWith("/")) throw new Error(`Docs images are served by this site: ${href}`);
        const { width, height } = webpSize(readFileSync(join(process.cwd(), "public", href)));
        return `<img src="${escape(href)}" alt="${escape(text)}" width="${width}" height="${height}" loading="lazy" decoding="async">`;
      },
      heading({ tokens, depth, text }: Tokens.Heading) {
        const plain = text.replace(/[`*_]/g, "");
        const base = slugify(plain) || "section";
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count + 1}`;
        headings.push({ depth, id, text: plain });
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${id}">${inner} <a class="anchor" href="#${id}" aria-label="Link to ${escape(plain)}">#</a></h${depth}>\n`;
      },
    },
  });

  let html = marked.parse(source) as string;
  const rendered = await Promise.all(blocks.map((block) => block.html));
  blocks.forEach((block, index) => {
    html = html.replace(block.placeholder, rendered[index] ?? "");
  });
  return { html, headings };
}

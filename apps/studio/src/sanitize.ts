/** Rich text arrives as HTML from a form; only what the editor itself can produce is kept. */

import { isSafeUrl } from "@greatcms/spec";
import { Parser } from "htmlparser2";

/** Elements the ProseMirror schema serializes to, and the attributes each may keep. */
const ALLOWED: Record<string, readonly string[]> = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  blockquote: [],
  pre: [],
  code: [],
  ul: [],
  ol: ["start"],
  li: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  a: ["href", "title"],
  img: ["src", "alt", "title"],
  br: [],
  hr: [],
};

const VOID = new Set(["br", "hr", "img"]);

/** Dropped along with everything inside them, not merely unwrapped. */
const DISCARD = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "svg",
  "math",
]);

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

function keepAttribute(tag: string, name: string, value: string): boolean {
  if (!ALLOWED[tag]?.includes(name)) return false;
  if (name === "href" || name === "src") return isSafeUrl(value);
  if (name === "start") return /^\d{1,6}$/.test(value);
  return true;
}

export function sanitizeRichText(html: string): string {
  let out = "";
  const open: string[] = [];
  let discarding = 0;

  const parser = new Parser(
    {
      onopentag(tag, attributes) {
        if (discarding > 0 || DISCARD.has(tag)) {
          if (!VOID.has(tag)) discarding += 1;
          return;
        }
        if (!(tag in ALLOWED)) return;
        const kept = Object.entries(attributes)
          .filter(([name, value]) => keepAttribute(tag, name, value))
          .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
          .join("");
        out += `<${tag}${kept}>`;
        if (!VOID.has(tag)) open.push(tag);
      },
      ontext(text) {
        if (discarding === 0) out += escapeText(text);
      },
      onclosetag(tag) {
        if (discarding > 0) {
          if (!VOID.has(tag)) discarding -= 1;
          return;
        }
        if (VOID.has(tag) || !(tag in ALLOWED)) return;
        const index = open.lastIndexOf(tag);
        if (index === -1) return;
        // Close anything left open inside it, so the output always nests.
        while (open.length > index) out += `</${open.pop()}>`;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  while (open.length > 0) out += `</${open.pop()}>`;
  return out;
}

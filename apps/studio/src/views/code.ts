/** HTML shown as code, coloured on the server, so a page that shows a snippet still ships no script. */

import { raw } from "hono/html";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] as string);
}

function token(kind: string, text: string): string {
  return `<span class="tok-${kind}">${escape(text)}</span>`;
}

/** One tag: its name, then attributes with or without a quoted value, then the closing bracket. */
const TAG = /<(\/?)([A-Za-z][\w-]*)((?:\s+[^\s"'=<>/]+(?:=(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
const ATTRIBUTE = /(\s+)([^\s"'=<>/]+)(?:(=)("[^"]*"|'[^']*'))?/g;

/**
 * The source, escaped, with tags, attribute names and values wrapped in spans the stylesheet
 * colours. Anything that is not a well-formed tag is left as plain, escaped text.
 */
export function highlightHtml(source: string) {
  let out = "";
  let text = "";
  for (let index = 0; index < source.length;) {
    TAG.lastIndex = index;
    const match = source[index] === "<" ? TAG.exec(source) : null;
    if (!match) {
      text += source[index];
      index++;
      continue;
    }
    out += escape(text);
    text = "";
    const [whole, slash = "", name = "", attributes = "", selfClosing = ""] = match;
    out += token("punct", `<${slash}`) + token("tag", name);
    for (const [, space = "", attribute = "", equals, value] of attributes.matchAll(ATTRIBUTE)) {
      out += escape(space) + token("attr", attribute);
      if (equals && value) out += token("punct", equals) + token("value", value);
    }
    out += token("punct", `${selfClosing}>`);
    index += whole.length;
  }
  return raw(`<pre class="code"><code>${out}${escape(text)}</code></pre>`);
}

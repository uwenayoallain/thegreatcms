/** The one place this site reads GreatCMS: at prerender time, from the files in this folder. */

import { createReader } from "@greatcms/reader";
import { marked } from "marked";

const WORDS_PER_MINUTE = 220;

// The site's folder is where SvelteKit runs, before and after this module is bundled. A new
// reader per call, so in dev the next page load sees the studio's latest draft.
export const cms = () => createReader();

/** The first paragraph as plain text, for the home page to quote. */
function opening(html) {
  const first = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  return first
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

export function essays() {
  return cms()
    .collection("essays")
    .map((entry) => ({
      slug: entry.slug,
      title: entry.data.title,
      dek: entry.data.dek ?? "",
      date: String(entry.data.date),
      tags: entry.data.tags ?? [],
      featured: Boolean(entry.data.featured),
      minutes: Math.max(1, Math.round(entry.body.split(/\s+/).length / WORDS_PER_MINUTE)),
      // A code block scrolls sideways on a narrow screen, so the keyboard has to be able to reach it.
      html: marked.parse(entry.body, { async: false }).replaceAll("<pre>", '<pre tabindex="0">'),
    }))
    .map((essay) => Object.assign(essay, { opening: opening(essay.html) }))
    .toSorted((a, b) => b.date.localeCompare(a.date));
}

export function formatDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Every page's content, read by the reader on the server; `nuxt generate` saves it with each page. */

import { createReader } from "@greatcms/reader";
import { marked } from "marked";

export default defineEventHandler(() => {
  // `nuxt dev` reads the studio's unsaved drafts; a generated site never does.
  const cms = createReader({ root: process.cwd(), drafts: import.meta.dev });
  const releases = cms
    .collection("changelog")
    .map((entry) => {
      const data = entry.data as { version: string; title: string; date: string; kind?: string };
      // A studio edit stores the body as sanitized HTML; one written by hand is Markdown, which may hold HTML.
      return Object.assign({ slug: entry.slug }, data, {
        // A code block scrolls sideways on a narrow screen, so the keyboard has to be able to reach it.
        html: marked.parse(entry.body, { async: false }).replaceAll("<pre>", '<pre tabindex="0">'),
      });
    })
    .toSorted((a, b) => b.date.localeCompare(a.date));
  return {
    // Before anyone has named the product in the studio, the site still has the name it was built for.
    identity: { name: "Sundial", ...cms.region("site.identity") },
    hero: cms.region("home.hero"),
    features: cms.region("home.features"),
    pricing: cms.region("home.pricing"),
    faq: cms.region("home.faq"),
    releases,
  };
});

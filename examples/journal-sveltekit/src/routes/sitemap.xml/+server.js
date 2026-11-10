/** Every page worth finding; the subscribed and not-found pages are left out. */

import { essays } from "#lib/cms.js";

export const prerender = true;

export function GET({ url }) {
  const paths = ["/", "/about/", ...essays().map((essay) => `/essays/${essay.slug}/`)];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((path) => `  <url><loc>${new URL(path, url).href}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}

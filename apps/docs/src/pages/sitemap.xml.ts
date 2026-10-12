/** Every HTML page, listed by hand: the set is small and known at build time. */

import type { APIRoute } from "astro";
import { docsPages } from "../lib/cms";

export const GET: APIRoute = ({ site }) => {
  const paths = ["/", "/docs/", "/spec/", ...docsPages().map((page) => `/docs/${page.slug}/`)];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((path) => `  <url><loc>${new URL(path, site).href}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};

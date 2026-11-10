/** Every page a search engine should know about. */

import type { APIRoute } from "astro";
import { projects } from "../lib/cms";

export const GET: APIRoute = ({ site }) => {
  const paths = ["/", "/work/", "/contact/", ...projects().map((entry) => `/work/${entry.slug}/`)];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((path) => `  <url><loc>${new URL(path, site).href}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};

/** Every page worth finding; the thank-you and not-found pages are left out. */

import { createReader } from "@greatcms/reader";

export default defineEventHandler((event) => {
  const site = useRuntimeConfig(event).public.siteUrl;
  const releases = createReader({ root: process.cwd() }).collection("changelog");
  const paths = ["/", "/changelog/", ...releases.map((entry) => `/changelog/${entry.slug}/`)];
  setHeader(event, "content-type", "application/xml; charset=utf-8");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((path) => `  <url><loc>${new URL(path, site).href}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
});

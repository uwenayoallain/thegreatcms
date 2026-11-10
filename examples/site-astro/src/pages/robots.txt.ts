/** Open to every crawler, and pointed at the sitemap under whatever address the site is built for. */

import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", site).href}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

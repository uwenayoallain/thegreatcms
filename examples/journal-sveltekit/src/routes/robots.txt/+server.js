/** Open to every crawler, and pointed at the sitemap. */

export const prerender = true;

export function GET({ url }) {
  return new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", url).href}\n`,
    {
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
}

/** Open to every crawler, and pointed at the sitemap. */

export default defineEventHandler((event) => {
  const site = useRuntimeConfig(event).public.siteUrl;
  setHeader(event, "content-type", "text/plain; charset=utf-8");
  return `User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", site).href}\n`;
});

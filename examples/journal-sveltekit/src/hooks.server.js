import { dev } from "$app/env";
import { injectPreviewChrome } from "@greatcms/reader/vite";

/**
 * SvelteKit renders pages itself rather than through Vite's index.html, so the studio's preview
 * chrome is added here, in development only. A prerendered page carries none of it.
 */
export async function handle({ event, resolve }) {
  if (!dev) return resolve(event);
  return resolve(event, {
    transformPageChunk: ({ html, done }) => (done ? injectPreviewChrome(html) : html),
  });
}

/** The studio's live preview for SvelteKit: the content watcher and a server hook. */

import { greatcmsWatch as watch, injectPreviewChrome, type WatchOptions } from "./vite.js";

/**
 * The Vite plugin for `vite.config`. SvelteKit renders pages itself and never
 * runs Vite's HTML hook, so the preview script comes from `greatcmsHandle`.
 */
export function greatcmsWatch(options: WatchOptions = {}): ReturnType<typeof watch> {
  return watch({ ...options, hideDevOverlays: false });
}

interface HandleInput<Event> {
  event: Event;
  resolve(
    event: Event,
    options?: { transformPageChunk?(input: { html: string; done: boolean }): string },
  ): Response | Promise<Response>;
}

/**
 * For `src/hooks.server`: adds the preview script to each page under `vite dev`,
 * and nothing to a build or a prerendered page.
 *
 *     export { greatcmsHandle as handle } from "@greatcms/reader/sveltekit";
 *
 * Compose it with your own hooks through `sequence` from `@sveltejs/kit/hooks`.
 */
export function greatcmsHandle<Event>({ event, resolve }: HandleInput<Event>) {
  if (process.env.NODE_ENV !== "development") return resolve(event);
  let added = false;
  return resolve(event, {
    // A streamed page arrives in chunks; the head is in the first, the end in the last.
    transformPageChunk: ({ html, done }) => {
      if (added || !(html.includes("</head>") || done)) return html;
      added = true;
      return injectPreviewChrome(html);
    },
  });
}

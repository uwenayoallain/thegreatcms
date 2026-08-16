/** A Vite plugin that makes content edits visible in dev. */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, DRAFT_DIR, parseConfig, type CmsConfig } from "@greatcms/spec";

export interface WatchOptions {
  /** Site root — the directory containing `.cms/`. Defaults to the Vite root. */
  root?: string;
  /** Extra directories to watch, relative to the root. */
  include?: string[];
  /**
   * Hide framework dev overlays when the page is being previewed inside the
   * studio. On by default: the studio frames your real dev server, so Astro's
   * dev toolbar and Nuxt's devtools sit on top of the page you are editing.
   */
  hideDevOverlays?: boolean;
}

/** Minimal shape of the Vite server this plugin touches. */
interface DevServer {
  watcher: {
    add(paths: string | string[]): void;
    on(event: "add" | "change" | "unlink", handler: (path: string) => void): void;
  };
  restart(): Promise<void> | void;
  ws?: { send(payload: { type: "full-reload"; path: string }): void };
  hot?: { send(payload: { type: "full-reload"; path: string }): void };
  config?: { logger?: { info(message: string): void } };
}

export interface VitePluginLike {
  name: string;
  apply: "serve";
  configureServer(server: DevServer): void;
  transformIndexHtml?: (html: string) => string;
}

/**
 * Hides the dev overlays a framework paints over its own pages, but only when
 * the page is in a frame — which in dev means the studio's live preview. The
 * toolbar belongs on your own tab, not on top of the section you are editing,
 * and the studio cannot reach into a cross-origin frame to remove it.
 *
 * Injected by the dev server only, so a built page never carries it.
 */
export const PREVIEW_SCRIPT = `
// Comparing the window references is allowed across origins; reading them is not.
if (window.top !== window.self) {
  document.documentElement.setAttribute("data-greatcms-framed", "");
  const style = document.createElement("style");
  style.dataset.greatcmsPreview = "";
  style.textContent = [
    "astro-dev-toolbar",
    "#nuxt-devtools-anchor",
    "#nuxt-devtools-container",
    "#__next-build-watcher",
    "nextjs-portal",
  ].map((selector) => selector + " { display: none !important; }").join("\\n");
  document.head.append(style);
}
`;

/** The same thing as markup, for frameworks that do run Vite's HTML transform. */
export const PREVIEW_CHROME = `<script type="module" data-greatcms-preview>${PREVIEW_SCRIPT}</script>`;

/** Puts the snippet last in <head>, or at the end when there is no head. */
export function injectPreviewChrome(html: string): string {
  if (html.includes("data-greatcms-preview")) return html;
  return html.includes("</head>")
    ? html.replace("</head>", `${PREVIEW_CHROME}</head>`)
    : `${PREVIEW_CHROME}${html}`;
}

export function greatcmsWatch(options: WatchOptions = {}): VitePluginLike {
  return {
    name: "greatcms:watch-content",
    // Dev only: a build reads the files once, from disk, and is already correct.
    apply: "serve",

    transformIndexHtml: (html: string) =>
      options.hideDevOverlays === false ? html : injectPreviewChrome(html),

    configureServer(server: DevServer) {
      const root = resolve(options.root ?? process.cwd());
      const config = loadConfig(root);

      const directories = [
        config.content.regions,
        config.content.media,
        // Unsaved edits from the studio land here, and are what makes the editor's view.
        DRAFT_DIR,
        ...collectionPaths(root),
        ...(options.include ?? []),
      ]
        .map((directory) => join(root, directory))
        .filter((directory, index, all) => all.indexOf(directory) === index);

      for (const directory of directories) server.watcher.add(directory);

      // Chokidar will not report a directory that does not exist yet, and the draft.
      server.watcher.add(join(root, DRAFT_DIR, "**"));

      let pending: NodeJS.Timeout | undefined;
      const onChange = (path: string) => {
        if (!directories.some((directory) => path.startsWith(directory))) return;

        // A publish writes several files at once; one reload covers them all.
        clearTimeout(pending);
        pending = setTimeout(() => {
          server.config?.logger?.info("[greatcms] content changed — reloading");
          // A reload is enough because the reader re-reads content on every call in development.
          const socket = server.hot ?? server.ws;
          if (socket) socket.send({ type: "full-reload", path: "*" });
          else void server.restart();
        }, 80);
      };

      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
      server.watcher.on("unlink", onChange);
    },
  };
}

function loadConfig(root: string): CmsConfig {
  for (const name of [".cms/config.json", ".cms/config.yaml", ".cms/config.yml"]) {
    const path = join(root, name);
    if (existsSync(path)) return parseConfig(readFileSync(path, "utf8"), name);
  }
  return DEFAULT_CONFIG;
}

/** Collections live wherever the schema says, which is often outside `content/`. */
function collectionPaths(root: string): string[] {
  for (const name of [".cms/schema.json", ".cms/schema.yaml", ".cms/schema.yml"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      // Parsed loosely: a schema this cannot read must not stop a dev server.
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/^\s{4}path:\s*(\S+)\s*$/gm)].map((match) =>
        String(match[1]).replace(/^["']|["']$/g, ""),
      );
    } catch {
      return [];
    }
  }
  return [];
}

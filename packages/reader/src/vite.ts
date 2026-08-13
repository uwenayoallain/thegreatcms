/**
 * A Vite plugin that makes content edits visible in dev.
 *
 * The reader deliberately reads files with `fs` so it stays framework-neutral —
 * but that means Vite never learns those files are dependencies, so editing one
 * changes the disk and nothing else. The dev server keeps serving the module it
 * already evaluated, and the page looks unchanged even though the content is
 * not.
 *
 * This watches the directories the site's own config declares and restarts the
 * dev server when one changes. Restarting rather than invalidating is
 * deliberate: content is read at module scope, so the module graph has to be
 * rebuilt for a re-read to happen at all, and guessing which modules to
 * invalidate would work until someone read content somewhere new.
 *
 * Optional, and dev-only. Builds are unaffected.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, parseConfig, type CmsConfig } from "@greatcms/spec";

export interface WatchOptions {
  /** Site root — the directory containing `.cms/`. Defaults to the Vite root. */
  root?: string;
  /** Extra directories to watch, relative to the root. */
  include?: string[];
}

/** Minimal shape of the Vite server this plugin touches. */
interface DevServer {
  watcher: {
    add(paths: string | string[]): void;
    on(event: "add" | "change" | "unlink", handler: (path: string) => void): void;
  };
  restart(): Promise<void> | void;
  config?: { logger?: { info(message: string): void } };
}

export interface VitePluginLike {
  name: string;
  apply: "serve";
  configureServer(server: DevServer): void;
}

export function greatcmsWatch(options: WatchOptions = {}): VitePluginLike {
  return {
    name: "greatcms:watch-content",
    // Dev only: a build reads the files once, from disk, and is already correct.
    apply: "serve",

    configureServer(server: DevServer) {
      const root = resolve(options.root ?? process.cwd());
      const config = loadConfig(root);

      const directories = [
        config.content.regions,
        config.content.media,
        ...collectionPaths(root),
        ...(options.include ?? []),
      ]
        .map((directory) => join(root, directory))
        .filter((directory, index, all) => all.indexOf(directory) === index);

      for (const directory of directories) server.watcher.add(directory);

      let pending: NodeJS.Timeout | undefined;
      const onChange = (path: string) => {
        if (!directories.some((directory) => path.startsWith(directory))) return;

        // A publish writes several files at once; one restart covers them all.
        clearTimeout(pending);
        pending = setTimeout(() => {
          server.config?.logger?.info("[greatcms] content changed — reloading");
          void server.restart();
        }, 60);
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
      // Parsed loosely on purpose: a schema this plugin cannot read should not
      // stop a dev server from starting.
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

/** Finds fonts a site loads from another host at page load: the usual cause of text that moves. */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** Hosts that serve font stylesheets or files to pages. */
const FONT_HOSTS =
  /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.bunny\.net|use\.typekit\.net|fonts\.cdnfonts\.com|api\.fontshare\.com/;
const SOURCE = /\.(?:css|scss|sass|less|astro|html|svelte|vue|[cm]?[jt]sx?|mdx)$/;
const SKIP = new Set(["node_modules", "dist", "build", "out", "coverage", "public"]);
const MAX_FILES = 3000;
const MAX_BYTES = 512 * 1024;

/** The site's own source files that name a font host, relative to `root`, in order. */
export async function remoteFonts(root: string): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || seen >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (seen >= MAX_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        // oxlint-disable-next-line no-await-in-loop -- one folder at a time keeps the order and the count
        await walk(path, depth + 1);
      } else if (entry.isFile() && SOURCE.test(entry.name)) {
        seen++;
        // oxlint-disable-next-line no-await-in-loop -- see above
        const size = await stat(path).then(
          (info) => info.size,
          () => MAX_BYTES + 1,
        );
        if (size > MAX_BYTES) continue;
        // oxlint-disable-next-line no-await-in-loop -- see above
        const text = await readFile(path, "utf8").catch(() => "");
        if (FONT_HOSTS.test(text)) found.push(relative(root, path));
      }
    }
  };
  await walk(root, 0);
  return found;
}

/** What to do about it, for the framework the project uses. */
export function fontRemedy(dependencies: Record<string, unknown>): string {
  return "astro" in dependencies
    ? "fix: list each family under `fonts` in astro.config and put a `<Font>` for it in the layout's head (https://docs.astro.build/en/guides/fonts/), then remove the link or @import. New pages need nothing; a new family is one more entry."
    : "fix: serve the font files from the site (an @fontsource package, or your framework's font support), with a fallback sized to match, then remove the link or @import.";
}

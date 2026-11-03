/** Wires the studio's live preview into a site's own config: small additive edits, or a note when a file is not a shape we recognise. */

import type { FrameworkId } from "./detect.js";
import { VERSION } from "./version.js";

/** The reader is released with the CLI, so this CLI's version is the reader to install. */
export const READER_RANGE = `^${VERSION}`;

export interface FileEdit {
  path: string;
  content: string;
  /** The file as it was, or null when the edit creates it. */
  before: string | null;
}

export interface Wiring {
  edits: FileEdit[];
  /** What still needs a person, when a file was not one to edit safely. */
  manual: string[];
}

type Read = (path: string) => Promise<string | null>;

export async function wirePreview(framework: FrameworkId, read: Read): Promise<Wiring> {
  switch (framework) {
    case "astro":
      return wireConfig(read, CONFIGS.astro, wireAstro, ASTRO_MANUAL);
    case "nuxt":
      return wireConfig(read, CONFIGS.nuxt, wireNuxt, NUXT_MANUAL);
    case "sveltekit":
      return wireSvelteKit(read);
    case "next":
      return wireNext(read);
    default:
      return { edits: [], manual: [] };
  }
}

/** Adds `@greatcms/reader` to `dependencies`: the site imports it at build time and, in Next.js, in its layout. */
export function withReader(source: string): string | null {
  const parsed = JSON.parse(source) as Record<string, Record<string, string> | undefined>;
  if (parsed.dependencies?.["@greatcms/reader"] || parsed.devDependencies?.["@greatcms/reader"])
    return null;
  const dependencies = { ...parsed.dependencies, "@greatcms/reader": READER_RANGE };
  parsed.dependencies = Object.fromEntries(
    Object.entries(dependencies).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const indent = /^(\s+)"/m.exec(source)?.[1] ?? "  ";
  return `${JSON.stringify(parsed, null, indent)}\n`;
}

const CONFIGS = {
  astro: ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.mts"],
  nuxt: ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"],
  vite: ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"],
  nextLayout: [
    "app/layout.tsx",
    "app/layout.jsx",
    "app/layout.js",
    "src/app/layout.tsx",
    "src/app/layout.jsx",
    "src/app/layout.js",
  ],
  svelteHooks: ["src/hooks.server.ts", "src/hooks.server.js"],
};

const ASTRO_MANUAL =
  'In astro.config: import greatcms from "@greatcms/reader/astro", then integrations: [greatcms()].';
const NUXT_MANUAL = 'In nuxt.config: modules: ["@greatcms/reader/nuxt"].';
const SVELTE_PLUGIN_MANUAL =
  'In vite.config: import { greatcmsWatch } from "@greatcms/reader/sveltekit", then plugins: [greatcmsWatch(), sveltekit()].';
const SVELTE_HOOK_MANUAL =
  'In src/hooks.server: compose greatcmsHandle from "@greatcms/reader/sveltekit" into your handle with sequence() from "@sveltejs/kit/hooks".';
const NEXT_MANUAL =
  'In your root layout: import { GreatcmsPreview } from "@greatcms/reader/next", then render <GreatcmsPreview /> inside <head>.';

async function first(read: Read, paths: string[]) {
  for (const path of paths) {
    // oxlint-disable-next-line no-await-in-loop -- the first file that exists wins
    const source = await read(path);
    if (source !== null) return { path, source };
  }
  return null;
}

async function wireConfig(
  read: Read,
  paths: string[],
  edit: (source: string) => string | null,
  manual: string,
): Promise<Wiring> {
  const found = await first(read, paths);
  if (!found) return { edits: [], manual: [manual] };
  return apply(found, edit(found.source), manual);
}

function apply(
  found: { path: string; source: string },
  content: string | null,
  manual: string,
): Wiring {
  if (content === null) return { edits: [], manual: [manual] };
  if (content === found.source) return { edits: [], manual: [] };
  return { edits: [{ path: found.path, content, before: found.source }], manual: [] };
}

export function wireAstro(source: string): string | null {
  if (source.includes("@greatcms/reader/astro")) return source;
  const next = intoArray(source, "integrations", "greatcms()", "defineConfig");
  return next === null
    ? null
    : addImport(next, `import greatcms from ${quoted(source, "@greatcms/reader/astro")};`);
}

export function wireNuxt(source: string): string | null {
  if (source.includes("@greatcms/reader/nuxt")) return source;
  return intoArray(source, "modules", quoted(source, "@greatcms/reader/nuxt"), "defineNuxtConfig");
}

export function wireVitePlugin(source: string): string | null {
  if (source.includes("@greatcms/reader/sveltekit")) return source;
  const next = prepend(source, "plugins", "greatcmsWatch()");
  if (next === null) return null;
  return addImport(
    next,
    `import { greatcmsWatch } from ${quoted(source, "@greatcms/reader/sveltekit")};`,
  );
}

export function wireNextLayout(source: string): string | null {
  if (source.includes("@greatcms/reader/next")) return source;
  let next: string;
  const head = /^([^\S\n]*)<head(?:\s[^>]*)?>/m.exec(source);
  if (head) {
    const at = head.index + head[0].length;
    next = `${source.slice(0, at)}\n${head[1]}  <GreatcmsPreview />${source.slice(at)}`;
  } else {
    const body = /^([^\S\n]*)<body[\s>]/m.exec(source);
    if (!body) return null;
    const indent = body[1] ?? "";
    next = `${source.slice(0, body.index)}${indent}<head>\n${indent}  <GreatcmsPreview />\n${indent}</head>\n${source.slice(body.index)}`;
  }
  return addImport(
    next,
    `import { GreatcmsPreview } from ${quoted(source, "@greatcms/reader/next")};`,
  );
}

async function wireSvelteKit(read: Read): Promise<Wiring> {
  const plugin = await wireConfig(read, CONFIGS.vite, wireVitePlugin, SVELTE_PLUGIN_MANUAL);
  const hooks = await first(read, CONFIGS.svelteHooks);
  if (hooks?.source.includes("greatcmsHandle")) return plugin;
  if (hooks) return { edits: plugin.edits, manual: [...plugin.manual, SVELTE_HOOK_MANUAL] };
  const typescript = (await read("tsconfig.json")) !== null;
  return {
    edits: [
      ...plugin.edits,
      {
        path: typescript ? "src/hooks.server.ts" : "src/hooks.server.js",
        content:
          '// The studio\'s live preview under `vite dev`; a built page carries none of it.\nexport { greatcmsHandle as handle } from "@greatcms/reader/sveltekit";\n',
        before: null,
      },
    ],
    manual: plugin.manual,
  };
}

async function wireNext(read: Read): Promise<Wiring> {
  const layout = await first(read, CONFIGS.nextLayout);
  if (!layout) return { edits: [], manual: [NEXT_MANUAL] };
  return apply(layout, wireNextLayout(layout.source), NEXT_MANUAL);
}

/**
 * Puts `item` first in the config's `key: [...]` array, or adds the key to the
 * object passed to `define(...)`. Null when neither shape is there to edit.
 */
function intoArray(source: string, key: string, item: string, define: string): string | null {
  const empty = new RegExp(`\\b${key}\\s*:\\s*\\[\\s*\\]`);
  if (empty.test(source)) return source.replace(empty, `${key}: [${item}]`);
  const listed = prepend(source, key, item);
  if (listed !== null) return listed;
  const bare = new RegExp(`\\b${define}\\(\\s*\\{\\s*\\}\\s*\\)`);
  if (bare.test(source)) return source.replace(bare, `${define}({ ${key}: [${item}] })`);
  const open = new RegExp(`\\b${define}\\(\\s*\\{`);
  if (open.test(source)) return source.replace(open, (match) => `${match}\n  ${key}: [${item}],`);
  return null;
}

/** Puts `item` first in `key: [...]`, on its own line when the array is written one item per line. */
function prepend(source: string, key: string, item: string): string | null {
  const list = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\S\\n]*\\n[^\\S\\n]*)?`);
  const match = list.exec(source);
  if (!match) return null;
  const at = match.index + match[0].length;
  const separator = match[1] ? `,${match[1]}` : ", ";
  return `${source.slice(0, at)}${item}${separator}${source.slice(at)}`;
}

const IMPORT = /^import(?:[\s\S]*?\bfrom)?\s*["'][^"'\n]+["'][^\S\n]*;?/gm;

/** After the last import, so the file's own order and its directives stay as they were. */
function addImport(source: string, line: string): string {
  const last = [...source.matchAll(IMPORT)].at(-1);
  if (!last) return `${line}\n${source}`;
  const end = last.index + last[0].length;
  return `${source.slice(0, end)}\n${line}${source.slice(end)}`;
}

/** A module specifier in the quote style the file already uses. */
function quoted(source: string, specifier: string): string {
  const last = [...source.matchAll(IMPORT)].at(-1)?.[0];
  const single = last
    ? last.trimEnd().replace(/;$/, "").endsWith("'")
    : /['"]/.exec(source)?.[0] === "'";
  return single ? `'${specifier}'` : `"${specifier}"`;
}

/** The package manager a project uses: what it declares, then its lockfile, then npm. */
export function packageManager(
  files: string[],
  packageJson: { packageManager?: unknown } | undefined,
): string {
  const declared =
    typeof packageJson?.packageManager === "string"
      ? packageJson.packageManager.split("@")[0]
      : undefined;
  if (declared && ["pnpm", "npm", "yarn", "bun"].includes(declared)) return declared;
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  return packageJson ? "npm" : "pnpm";
}

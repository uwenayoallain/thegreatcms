/**
 * Moves an Astro site's Google Fonts onto the site itself: the families in its font link become
 * entries in astro.config, tags in the layout's head, and variables in its CSS. It plans every
 * edit before making any, and plans none when a file is not shaped the way it expects.
 */

export interface Family {
  name: string;
  cssVariable: string;
  weights: number[];
  styles: Array<"normal" | "italic">;
  fallbacks: string[];
}

export interface FontPlan {
  families: Family[];
  /** Files to rewrite, by path, with their new content. */
  changes: Map<string, string>;
  /** Why nothing can be done safely; empty when the plan is good. */
  problems: string[];
}

const GOOGLE_URL = /https:\/\/fonts\.googleapis\.com\/css2?\?[^'")\s<>]+/g;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ]{0,60}$/;

const slug = (name: string) => name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

function fallbacksFor(name: string): string[] {
  if (/mono|code/i.test(name)) return ["ui-monospace", "monospace"];
  if (/serif/i.test(name) && !/sans/i.test(name)) return ["ui-serif", "serif"];
  return ["ui-sans-serif", "system-ui", "sans-serif"];
}

/** The families one Google Fonts stylesheet address asks for, or null when it does not read. */
export function familiesIn(url: string): Family[] | null {
  let query: URLSearchParams;
  try {
    query = new URL(url.replaceAll("&amp;", "&")).searchParams;
  } catch {
    return null;
  }
  const asked = query.getAll("family").flatMap((value) => value.split("|"));
  if (asked.length === 0) return null;
  const families: Family[] = [];
  for (const entry of asked) {
    const [rawName = "", axes = ""] = entry.split(":");
    const name = rawName.replaceAll("+", " ").trim();
    if (!NAME.test(name)) return null;
    const weights = new Set<number>();
    const styles = new Set<"normal" | "italic">();
    const [axisList = "", values = ""] = axes.includes("@") ? axes.split("@") : ["", axes];
    const axisNames = axisList.split(",").filter(Boolean);
    for (const tuple of values.split(/[;,]/).filter(Boolean)) {
      if (axisNames.length > 1) continue;
      // `400`, `400italic`, `300..700`: the last is a range, kept as its two ends.
      for (const part of tuple.split("..")) {
        const weight = Number.parseInt(part, 10);
        if (weight >= 100 && weight <= 900) weights.add(weight);
      }
      styles.add(/i(?:talic)?$/.test(tuple) ? "italic" : "normal");
    }
    if (axisNames.length > 1) {
      // `ital,wght@0,400;1,700`: each tuple is one value per axis, in the order named.
      for (const tuple of values.split(";").filter(Boolean)) {
        const parts = tuple.split(",");
        const italic = parts[axisNames.indexOf("ital")];
        const weight = Number.parseInt(parts[axisNames.indexOf("wght")] ?? "", 10);
        if (weight >= 100 && weight <= 900) weights.add(weight);
        styles.add(italic === "1" ? "italic" : "normal");
      }
    }
    families.push({
      name,
      cssVariable: `--font-${slug(name)}`,
      weights: weights.size ? [...weights].toSorted((a, b) => a - b) : [400],
      styles: styles.size ? [...styles].toSorted().toReversed() : ["normal"],
      fallbacks: fallbacksFor(name),
    });
  }
  return families;
}

function merge(all: Family[]): Family[] {
  const byName = new Map<string, Family>();
  for (const family of all) {
    const known = byName.get(family.name);
    if (!known) {
      byName.set(family.name, { ...family });
      continue;
    }
    known.weights = [...new Set([...known.weights, ...family.weights])].toSorted((a, b) => a - b);
    known.styles = [...new Set([...known.styles, ...family.styles])].toSorted().toReversed();
  }
  return [...byName.values()];
}

const list = (values: Array<string | number>) =>
  values.map((value) => (typeof value === "number" ? value : `'${value}'`)).join(", ");

function configBlock(families: Family[]): string {
  const entries = families.map(
    (family) => `    {
      provider: fontProviders.google(),
      name: '${family.name}',
      cssVariable: '${family.cssVariable}',
      weights: [${list(family.weights)}],
      styles: [${list(family.styles)}],
      subsets: ['latin'],
      // Shown if it arrives before first paint, kept for the next page if not: text never swaps.
      display: 'optional',
      fallbacks: [${list(family.fallbacks)}],
    },`,
  );
  return `  // Served from this site with fallbacks measured to match, so text does not move when a font arrives.
  fonts: [
${entries.join("\n")}
  ],
`;
}

function editConfig(source: string, families: Family[]): string | null {
  if (/^\s*fonts\s*:/m.test(source) || source.includes("fontProviders")) return null;
  const imported = /import\s*\{([^}]*)\}\s*from\s*(['"])astro\/config\2/.exec(source);
  if (!imported || !/\bdefineConfig\b/.test(imported[1] ?? "")) return null;
  const close = source.lastIndexOf("});");
  if (close === -1 || !/defineConfig\(\s*\{/.test(source)) return null;
  const names = `${(imported[1] ?? "").trim().replace(/,\s*$/, "")}, fontProviders`;
  let next = source.replace(
    imported[0],
    `import { ${names} } from ${imported[2]}astro/config${imported[2]}`,
  );
  const at = next.lastIndexOf("});");
  const before = next.slice(0, at).replace(/\s*$/, "");
  next = `${before}${before.endsWith(",") || before.endsWith("{") ? "" : ","}\n${configBlock(families)}${next.slice(at)}`;
  return next;
}

function editLayout(source: string, families: Family[]): string | null {
  const head = /<head(?:\s[^>]*)?>/.exec(source);
  if (!head || (source.includes("astro:assets") && /\bFont\b/.test(source))) return null;
  const indent = /\n([ \t]*)<head/.exec(source)?.[1] ?? "";
  const tags = families
    .map(
      (family, index) =>
        `\n${indent}  <Font cssVariable="${family.cssVariable}"${index < 2 ? " preload" : ""} />`,
    )
    .join("");
  let next = source.replace(head[0], `${head[0]}${tags}`);
  const line = "import { Font } from 'astro:assets';";
  next = next.startsWith("---")
    ? next.replace(/^---[ \t]*\r?\n/, (open) => `${open}${line}\n`)
    : `---\n${line}\n---\n${next}`;
  return next;
}

const FONT_HOST = /fonts\.(?:googleapis|gstatic)\.com/;

/** Takes the old ways of loading the fonts out of one file, and points its font names at the new ones. */
function editSource(path: string, source: string, families: Family[]): string {
  let next = source
    // `@import url(...)` in a stylesheet or a style block; the address itself holds semicolons.
    .replaceAll(
      /^[ \t]*@import\s+(?:url\(\s*)?(['"]?)https:\/\/fonts\.googleapis\.com[^'")\s]*\1\s*\)?[^;\n]*;[ \t]*\r?\n?/gm,
      "",
    )
    // `<link ... fonts.googleapis.com ...>`, preconnects included.
    .replaceAll(/^[ \t]*<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>[ \t]*\r?\n?/gm, "")
    // `{ rel: "preconnect", href: "https://fonts.gstatic.com" },` in a list of head links.
    .replaceAll(/^[ \t]*\{[^{}\n]*fonts\.(?:googleapis|gstatic)\.com[^{}\n]*\},?[ \t]*\r?\n/gm, "");
  if (/\.(?:css|scss|sass|less|astro|svelte|vue|html)$/.test(path)) {
    for (const family of families) {
      const quoted = new RegExp(`(['"])${family.name}\\1`, "g");
      next = next
        .split("\n")
        .map((line) =>
          /font/i.test(line) ? line.replaceAll(quoted, `var(${family.cssVariable})`) : line,
        )
        .join("\n");
    }
  }
  // A removed first line leaves the blank one that followed it at the top.
  return /^\r?\n/.test(next) && !/^\r?\n/.test(source) ? next.replace(/^(?:\r?\n)+/, "") : next;
}

/**
 * Plans the whole change from the site's source files. `files` maps each path to its content;
 * `config` and `layouts` say which of them are the Astro config and the pages' layouts.
 */
export function planFonts(
  files: Map<string, string>,
  config: string | undefined,
  layouts: string[],
): FontPlan {
  const urls = [...files.values()].flatMap((content) => content.match(GOOGLE_URL) ?? []);
  const parsed = urls.map((url) => familiesIn(url));
  const plan: FontPlan = { families: [], changes: new Map(), problems: [] };
  if (urls.length === 0) return plan;
  if (parsed.some((families) => families === null)) {
    plan.problems.push("a Google Fonts address in the site could not be read");
    return plan;
  }
  plan.families = merge(parsed.flat() as Family[]);
  if (!config) plan.problems.push("no astro.config file was found");
  if (layouts.length === 0) plan.problems.push("no .astro file with a <head> was found");
  const newConfig = config ? editConfig(files.get(config) ?? "", plan.families) : null;
  if (config && !newConfig) {
    plan.problems.push(
      `${config} already sets fonts, or does not import defineConfig from astro/config in the usual way`,
    );
  }
  const newLayouts = layouts.map(
    (path) => [path, editLayout(files.get(path) ?? "", plan.families)] as const,
  );
  for (const [path, edited] of newLayouts) {
    if (!edited)
      plan.problems.push(`${path} already uses Astro's Font, or has no <head> to add to`);
  }
  if (plan.problems.length > 0) return plan;
  plan.changes.set(config as string, newConfig as string);
  for (const [path, edited] of newLayouts) plan.changes.set(path, edited as string);
  for (const [path, content] of files) {
    if (path === config) continue;
    const base = plan.changes.get(path) ?? content;
    const edited = editSource(path, base, plan.families);
    if (edited !== content) plan.changes.set(path, edited);
  }
  // Whatever still names a font host is something this did not understand: better told than left.
  for (const [path, content] of files) {
    if (FONT_HOST.test(plan.changes.get(path) ?? content)) {
      plan.problems.push(`${path} loads fonts in a way this command does not rewrite`);
    }
  }
  if (plan.problems.length > 0) plan.changes.clear();
  return plan;
}

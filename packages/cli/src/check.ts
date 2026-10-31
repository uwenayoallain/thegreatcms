/** `greatcms check`: validate what is actually in the repository. */

import { ui } from "./ui.js";
import {
  DRAFT_DIR,
  isBlocksRegion,
  parseFrontmatter,
  parseRegionFile,
  regionIdFromPath,
  SpecIssue,
  validateFields,
  validateRegion,
  referencesIn,
  unknownSchemaKeys,
  type CmsConfig,
  type CmsSchema,
  type CollectionDef,
  type FieldDef,
  type RegionDocument,
  entryExtension,
  hasFrontmatter,
} from "@greatcms/spec";
import { scanHtml, scanMarkdown, skippedHeadings } from "./scan.js";

/** Reading the site. Separated so the checker is testable without a disk. */
export interface CheckPort {
  read(path: string): Promise<string | null>;
  /** Repo-relative paths directly inside `dir`. Missing directory → `[]`. */
  list(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

export interface CheckReport {
  /** Errors: content that will not render, or renders broken. These fail the command. */
  issues: readonly SpecIssue[];
  /** Worth fixing, but the site still builds: unused media, rich-text hygiene. */
  warnings: readonly SpecIssue[];
  /** Counts for the summary line: what was looked at, not what was wrong. */
  checked: { regions: number; entries: number; media: number; links: number };
  /** Regions with no content file: rendering schema defaults, which is fine. */
  defaults: readonly string[];
}

export interface CheckOptions {
  schema: CmsSchema;
  config: CmsConfig;
  files: CheckPort;
  /** The schema as written, so keys the format does not define can be reported. */
  schemaSource?: { name: string; source: string };
}

export async function checkSite({
  schema,
  config,
  files,
  schemaSource,
}: CheckOptions): Promise<CheckReport> {
  const issues: SpecIssue[] = schemaSource
    ? unknownSchemaKeys(schemaSource.source, { file: schemaSource.name })
    : [];
  const warnings: SpecIssue[] = [];
  const defaults: string[] = [];
  const media = new Map<string, { file: string; path: string }>();
  const links: Array<{ href: string; file: string; path: string }> = [];
  const references: Array<{ file: string; path: string; collection: string; slug: string }> = [];
  const addReferences = (file: string, fields: Record<string, FieldDef>, document: unknown) => {
    for (const found of referencesIn(fields, document, { blocks: schema.blocks })) {
      references.push({ file, ...found });
    }
  };
  // Raw text of everything that can reference media, defaults included.
  const texts: string[] = [JSON.stringify(schema)];

  const addMedia = (src: string, file: string, path: string) => {
    if (src !== "" && !media.has(src)) media.set(src, { file, path });
  };

  const addHref = (href: string, file: string, path: string) => {
    if (mediaFileFor(config, withoutQuery(href)) !== null) {
      addMedia(withoutQuery(href), file, path);
    } else if (href.startsWith("/") && !href.startsWith("//")) {
      links.push({ href, file, path });
    }
  };

  const inspectText = (file: string, path: string, text: string, markdown: boolean) => {
    const scanned = markdown ? scanMarkdown(text) : scanHtml(text);
    for (const src of scanned.images) addMedia(src, file, path);
    for (const link of scanned.links) {
      addHref(link.href, file, path);
      if (link.text === "") {
        warnings.push(
          new SpecIssue({
            code: "empty_link_text",
            file,
            path,
            message: `A link to ${link.href} has no text, so a screen reader announces only the URL.`,
            fix: "Give the link words that say where it goes.",
          }),
        );
      }
    }
    const skips = skippedHeadings(scanned.headings);
    if (skips.length > 0) {
      warnings.push(
        new SpecIssue({
          code: "skipped_heading_level",
          file,
          path,
          message: `Headings skip a level: ${skips.map(([from, to]) => `h${from} → h${to}`).join(", ")}.`,
          fix: "Use the next heading level down, so the outline reads in order.",
        }),
      );
    }
  };

  const inspect = (
    file: string,
    document: RegionDocument,
    fields: Record<string, FieldDef> | null,
    skip?: string,
  ) =>
    walkDocument(document, fields, schema, skip, (def, value, path) => {
      if (!isObject(value)) return;
      if (def.type === "image" || def.type === "file") {
        if (typeof value.src === "string") addMedia(value.src, file, path);
      } else if (def.type === "link") {
        if (typeof value.href === "string") addHref(value.href, file, path);
      } else if (def.type === "richtext") {
        if (typeof value.html === "string") inspectText(file, path, value.html, false);
      }
    });

  const regionsDir = trimSlashes(config.content.regions);

  // Every read is independent, so they all go out at once.
  const regions = await Promise.all(
    Object.entries(schema.regions).map(async ([regionId, region]) => {
      const file = `${regionsDir}/${regionId}.json`;
      return { regionId, region, file, source: await files.read(file) };
    }),
  );

  for (const { regionId, region, file, source } of regions) {
    if (source === null) {
      defaults.push(regionId);
      continue;
    }
    texts.push(source);

    let document: RegionDocument;
    try {
      document = parseRegionFile(source, file);
    } catch (error) {
      issues.push(
        new SpecIssue({
          code: "unreadable_content",
          file,
          message: (error as Error).message.replace(`${file}: `, ""),
          fix: "Fix the JSON, or delete the file to fall back to schema defaults.",
        }),
      );
      continue;
    }

    // Strict, unlike a reader: an extra key here is content the site will never.
    issues.push(...validateRegion(schema, regionId, document, { strict: true, file }).issues);
    inspect(file, document, isBlocksRegion(region) ? null : region.fields);
    addReferences(
      file,
      isBlocksRegion(region) ? { blocks: { type: "blocks", allow: region.allow } } : region.fields,
      document,
    );
  }

  // A file with no region is content nobody reads: usually a rename left behind.
  for (const path of await files.list(regionsDir)) {
    if (!path.endsWith(".json")) continue;
    const regionId = regionIdFromPath(config, path);
    if (regionId && !schema.regions[regionId]) {
      issues.push(
        new SpecIssue({
          code: "orphaned_content",
          file: path,
          message: `No region "${regionId}" in the schema, so nothing renders this file.`,
          fix: `Add \`${regionId}\` to the schema, rename the file, or delete it.`,
        }),
      );
    }
  }

  const collections = await Promise.all(
    Object.entries(schema.collections).map(async ([name, collection]) => {
      const extension = `.${entryExtension(collection.format)}`;
      const paths = (await files.list(trimSlashes(collection.path))).filter((path) =>
        path.endsWith(extension),
      );
      const sources = await Promise.all(
        paths.map(async (path) => ({ path, source: await files.read(path) })),
      );
      return { name, collection, extension, sources };
    }),
  );

  const slugs = new Map(
    collections.map(({ name, extension, sources }) => [
      name,
      new Set(sources.map(({ path }) => basename(path).slice(0, -extension.length))),
    ]),
  );

  let entries = 0;
  for (const { name, collection, sources } of collections) {
    for (const { path, source } of sources) {
      if (source === null) continue;
      entries += 1;
      texts.push(source);

      const entry = readEntry(collection, path, source);
      if (entry instanceof SpecIssue) {
        issues.push(entry);
        continue;
      }

      // Readers do not layer entries over defaults, so neither does the check.
      issues.push(
        ...validateFields(collection.fields, entry.document, {
          strict: true,
          file: path,
          blocks: schema.blocks,
        }).issues.map((issue) => withCollection(issue, name)),
      );
      inspect(path, entry.document, collection.fields, collection.body);
      addReferences(path, collection.fields, entry.document);
      if (entry.body !== null) inspectText(path, collection.body ?? "body", entry.body, true);
    }
  }

  // A reference to an entry that is not there renders as nothing, or as a broken link.
  for (const reference of references) {
    if (slugs.get(reference.collection)?.has(reference.slug)) continue;
    issues.push(
      new SpecIssue({
        code: "missing_reference",
        file: reference.file,
        path: reference.path,
        message: `No ${reference.collection} entry "${reference.slug}" exists to refer to.`,
        fix: `Pick an existing ${reference.collection} entry, or add one with that name.`,
      }),
    );
  }

  // An unpublished edit still counts as using an upload, or publishing it would break.
  const draftDirs = [regionsDir, ...Object.values(schema.collections).map((c) => c.path)];
  const drafts = (
    await Promise.all(draftDirs.map((dir) => files.list(`${DRAFT_DIR}/${trimSlashes(dir)}`)))
  ).flat();
  texts.push(...(await Promise.all(drafts.map(async (path) => (await files.read(path)) ?? ""))));

  // An image pointing at a file nobody committed is a broken picture in production.
  const referenced = await Promise.all(
    [...media].map(async ([src, where]) => {
      const local = mediaFileFor(config, src);
      return { src, where, local, present: local === null || (await files.exists(local)) };
    }),
  );

  for (const { src, where, local, present } of referenced) {
    if (present || local === null) continue;
    issues.push(
      new SpecIssue({
        code: "missing_media",
        file: where.file,
        path: where.path,
        message: `References ${src}, but ${local} is not in the repository.`,
        fix: "Commit the file, or re-upload it in the studio.",
      }),
    );
  }

  const routes = routesOf(config, schema);
  for (const { href, file, path } of links) {
    const target = sitePath(href);
    if (routes.listings.has(target)) continue;
    const candidates = routes.match(target);
    if (candidates.length === 0) continue; // a route the site writes itself
    if (candidates.some(({ collection, slug }) => slugs.get(collection)?.has(slug))) continue;
    issues.push(
      new SpecIssue({
        code: "broken_link",
        file,
        path,
        message: `Links to ${href}, but there is no ${candidates
          .map(({ collection, slug }) => `${collection} entry "${slug}"`)
          .join(" or ")}.`,
        fix: "Point the link at a page that exists, or create that entry.",
      }),
    );
  }

  const used = new Set<string>();
  for (const [src] of media) {
    const local = mediaFileFor(config, src);
    if (local) used.add(local);
  }
  const prefix = escapeRegExp(`${config.mediaUrlPrefix.replace(/\/+$/, "")}/`);
  const mention = new RegExp(`${prefix}([^\\s"'()<>[\\]\\\\?#]+)`, "g");
  for (const text of texts) {
    for (const match of text.matchAll(mention)) {
      const local = mediaFileFor(config, match[0]);
      if (local) used.add(local);
    }
  }

  for (const path of await files.list(trimSlashes(config.content.media))) {
    if (basename(path).startsWith(".") || used.has(path)) continue;
    warnings.push(
      new SpecIssue({
        code: "unused_media",
        file: path,
        message: "No region, entry or draft references this file.",
        fix: "Delete it, unless the site's own code uses it: check only reads content.",
      }),
    );
  }

  return {
    issues,
    warnings,
    checked: {
      regions: Object.keys(schema.regions).length - defaults.length,
      entries,
      media: media.size,
      links: links.length,
    },
    defaults,
  };
}

/** Formats a report the way the rest of the CLI reports things: what, then how. */
export function formatReport(report: CheckReport): string {
  const { checked, defaults, issues, warnings } = report;
  const u = ui();
  const lines: string[] = [];
  const list = (heading: string, items: readonly SpecIssue[], mark: (text: string) => string) => {
    lines.push(u.step(heading));
    for (const item of items) lines.push(mark(item.toString()));
    lines.push("");
  };

  if (issues.length > 0) list(`${plural(issues.length, "problem")} found:`, issues, u.err);
  if (warnings.length > 0) list(`${plural(warnings.length, "warning")}:`, warnings, u.warn);

  const looked = [
    plural(checked.regions, "region"),
    `${checked.entries} entr${checked.entries === 1 ? "y" : "ies"}`,
    plural(checked.media, "media reference"),
    plural(checked.links, "internal link"),
  ].join(", ");

  const tally = [issues, warnings]
    .map((items, i) =>
      items.length > 0 ? plural(items.length, i === 0 ? "problem" : "warning") : "",
    )
    .filter(Boolean)
    .join(", ");

  if (issues.length > 0) lines.push(u.err(u.bold(`${tally}; checked ${looked}`)));
  else if (warnings.length > 0) lines.push(u.warn(`content: OK, ${tally} (${looked})`));
  else lines.push(u.ok(`content: OK (${looked})`));

  if (defaults.length > 0) {
    lines.push(
      u.note(
        `${plural(defaults.length, "region")} with no content file, rendering schema defaults: ${defaults.join(", ")}`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** The machine-readable form, for CI and for agents. */
export function reportAsJson(report: CheckReport): string {
  return `${JSON.stringify(
    {
      ok: report.issues.length === 0,
      checked: report.checked,
      defaults: report.defaults,
      issues: report.issues.map(shape),
      warnings: report.warnings.map(shape),
    },
    null,
    2,
  )}\n`;
}

function shape(issue: SpecIssue) {
  return {
    code: issue.code,
    file: issue.file,
    path: issue.path,
    message: issue.message,
    fix: issue.fix,
  };
}

/** Reads one entry into the document shape the schema describes, keeping the prose body. */
function readEntry(
  collection: CollectionDef,
  path: string,
  source: string,
): { document: RegionDocument; body: string | null } | SpecIssue {
  try {
    if (collection.format === "json") {
      const parsed: unknown = JSON.parse(source);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected a JSON object.");
      }
      return { document: parsed as RegionDocument, body: null };
    }

    const { data, body } = parseFrontmatter(source, path);
    if (collection.body) {
      const field = collection.fields[collection.body];
      data[collection.body] = field?.type === "richtext" ? { html: body.trim() } : body.trim();
    }
    return { document: data, body };
  } catch (error) {
    return new SpecIssue({
      code: "unreadable_content",
      file: path,
      message: (error as Error).message.replace(`${path}: `, ""),
      fix: hasFrontmatter(collection.format) ? "Check the YAML frontmatter." : "Fix the JSON.",
    });
  }
}

/** Calls `visit` for every leaf field that holds a value, with its path in the document. */
function walkDocument(
  document: RegionDocument,
  fields: Record<string, FieldDef> | null,
  schema: CmsSchema,
  skip: string | undefined,
  visit: (def: FieldDef, value: unknown, path: string) => void,
): void {
  if (fields) {
    walkFields(fields, document, "", skip);
    return;
  }

  // A blocks region: each block declares its own type, and therefore its fields.
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  blocks.forEach((block, index) => {
    const type = (block as { _type?: unknown })?._type;
    const def = typeof type === "string" ? schema.blocks[type] : undefined;
    if (def && isObject(block)) walkFields(def.fields, block, `blocks[${index}]`);
  });

  function walkFields(
    defs: Record<string, FieldDef>,
    value: unknown,
    base: string,
    omit?: string,
  ): void {
    if (!isObject(value)) return;
    for (const [name, def] of Object.entries(defs)) {
      if (name !== omit) walk(def, value[name], base ? `${base}.${name}` : name);
    }
  }

  function walk(def: FieldDef, value: unknown, path: string): void {
    if (value === undefined || value === null) return;
    if (def.type === "group") {
      walkFields(def.fields, value, path);
      return;
    }
    if (def.type === "list") {
      if (Array.isArray(value)) value.forEach((item, i) => walk(def.of, item, `${path}[${i}]`));
      return;
    }
    if (def.type === "blocks") {
      if (!Array.isArray(value)) return;
      value.forEach((block, i) => {
        const type = (block as { _type?: unknown })?._type;
        const nested = typeof type === "string" ? schema.blocks[type] : undefined;
        if (nested) walkFields(nested.fields, block, `${path}[${i}]`);
      });
      return;
    }
    visit(def, value, path);
  }
}

interface Routes {
  /** Every collection entry a site path could be, from `preview.paths`. */
  match(path: string): Array<{ collection: string; slug: string }>;
  /** The fixed part of a `{slug}` pattern, such as `/updates`: an index page the site writes. */
  listings: Set<string>;
}

function routesOf(config: CmsConfig, schema: CmsSchema): Routes {
  const exact: Array<{ path: string; collection: string; slug: string }> = [];
  const patterns: Array<{ pattern: RegExp; collection: string }> = [];
  const listings = new Set<string>();

  for (const [collection, rule] of Object.entries(config.preview?.paths ?? {})) {
    if (!Object.hasOwn(schema.collections, collection)) continue;
    const templates: Array<[string, string]> =
      typeof rule === "string" ? [["*", rule]] : Object.entries(rule);
    for (const [slug, template] of templates) {
      if (slug !== "*") {
        exact.push({ path: sitePath(template.replaceAll("{slug}", slug)), collection, slug });
        continue;
      }
      if (!template.includes("{slug}")) continue;
      const path = sitePath(template);
      const parts = path.split("{slug}").map(escapeRegExp);
      patterns.push({ pattern: new RegExp(`^${parts.join("([^/]+)")}$`), collection });
      const fixed = sitePath(path.slice(0, path.indexOf("{slug}")));
      if (fixed !== "/") listings.add(fixed);
    }
  }

  return {
    listings,
    match(path) {
      const found = exact
        .filter((route) => route.path === path)
        .map(({ collection, slug }) => ({ collection, slug }));
      for (const { pattern, collection } of patterns) {
        const slug = pattern.exec(path)?.[1];
        if (slug !== undefined) found.push({ collection, slug: safeDecode(slug) });
      }
      return found;
    },
  };
}

/** A link as the router sees it: no fragment or query, no `.html`, no trailing slash. */
function sitePath(href: string): string {
  const path = safeDecode(withoutQuery(href))
    .replace(/\.html$/, "")
    .replace(/\/index$/, "/")
    .replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

function withoutQuery(href: string): string {
  return href.replace(/[?#].*$/, "");
}

/** Maps a public media URL back to the file it must have been committed as. */
function mediaFileFor(config: CmsConfig, src: string): string | null {
  const prefix = `${config.mediaUrlPrefix.replace(/\/+$/, "")}/`;
  if (!src.startsWith(prefix)) return null; // an external URL is not ours to check
  return `${trimSlashes(config.content.media)}/${safeDecode(src.slice(prefix.length))}`;
}

/** Names the collection in the issue path, so `title` says which entry's title. */
function withCollection(issue: SpecIssue, name: string): SpecIssue {
  return new SpecIssue({
    code: issue.code,
    file: issue.file,
    path: issue.path ? `${name}.${issue.path}` : name,
    message: issue.message,
    ...(issue.fix ? { fix: issue.fix } : {}),
  });
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

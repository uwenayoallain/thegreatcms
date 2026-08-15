/** `greatcms check` — validate what is actually in the repository. */

import {
  fieldDefaults,
  isBlocksRegion,
  parseFrontmatter,
  parseRegionFile,
  regionIdFromPath,
  SpecIssue,
  validateFields,
  validateRegion,
  type CmsConfig,
  type CmsSchema,
  type CollectionDef,
  type FieldDef,
  type RegionDocument,
} from "@greatcms/spec";

/** Reading the site. Separated so the checker is testable without a disk. */
export interface CheckPort {
  read(path: string): Promise<string | null>;
  /** Repo-relative paths directly inside `dir`. Missing directory → `[]`. */
  list(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

export interface CheckReport {
  issues: readonly SpecIssue[];
  /** Counts for the summary line: what was looked at, not what was wrong. */
  checked: { regions: number; entries: number; media: number };
  /** Regions with no content file — rendering schema defaults, which is fine. */
  defaults: readonly string[];
}

export interface CheckOptions {
  schema: CmsSchema;
  config: CmsConfig;
  files: CheckPort;
}

export async function checkSite({ schema, config, files }: CheckOptions): Promise<CheckReport> {
  const issues: SpecIssue[] = [];
  const defaults: string[] = [];
  const media = new Map<string, { file: string; path: string }>();

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
    collectMedia(media, file, document, isBlocksRegion(region) ? null : region.fields, schema);
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
      const extension = collection.format === "markdown" ? ".md" : ".json";
      const paths = (await files.list(trimSlashes(collection.path))).filter((path) =>
        path.endsWith(extension),
      );
      const sources = await Promise.all(
        paths.map(async (path) => ({ path, source: await files.read(path) })),
      );
      return { name, collection, sources };
    }),
  );

  let entries = 0;
  for (const { name, collection, sources } of collections) {
    for (const { path, source } of sources) {
      if (source === null) continue;
      entries += 1;

      const entry = readEntry(collection, path, source);
      if (entry instanceof SpecIssue) {
        issues.push(entry);
        continue;
      }

      const document = { ...fieldDefaults(collection.fields), ...entry };
      issues.push(
        ...validateFields(collection.fields, document, {
          strict: true,
          file: path,
        }).issues.map((issue) => withCollection(issue, name)),
      );
      collectMedia(media, path, document, collection.fields, schema);
    }
  }

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
        fix: "Commit the file, or re-upload the image in the studio.",
      }),
    );
  }

  return {
    issues,
    checked: {
      regions: Object.keys(schema.regions).length - defaults.length,
      entries,
      media: media.size,
    },
    defaults,
  };
}

/** Formats a report the way the rest of the CLI reports things: what, then how. */
export function formatReport(report: CheckReport): string {
  const { checked, defaults, issues } = report;
  const lines: string[] = [];

  if (issues.length > 0) {
    lines.push(`${issues.length} problem${issues.length === 1 ? "" : "s"} found:`, "");
    for (const issue of issues) {
      lines.push(`  - ${issue.toString().replace(/\n/g, "\n  ")}`);
    }
    lines.push("");
  }

  const looked = [
    `${checked.regions} region${checked.regions === 1 ? "" : "s"}`,
    `${checked.entries} entr${checked.entries === 1 ? "y" : "ies"}`,
    `${checked.media} media reference${checked.media === 1 ? "" : "s"}`,
  ].join(", ");

  lines.push(issues.length === 0 ? `content: OK (${looked})` : `checked ${looked}`);

  if (defaults.length > 0) {
    lines.push(
      `${defaults.length} region${defaults.length === 1 ? "" : "s"} with no content file, rendering schema defaults: ${defaults.join(", ")}`,
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
      issues: report.issues.map((issue) => ({
        code: issue.code,
        file: issue.file,
        path: issue.path,
        message: issue.message,
        fix: issue.fix,
      })),
    },
    null,
    2,
  )}\n`;
}

/** Reads one entry into the document shape the schema describes. */
function readEntry(
  collection: CollectionDef,
  path: string,
  source: string,
): RegionDocument | SpecIssue {
  try {
    if (collection.format === "json") {
      const parsed: unknown = JSON.parse(source);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected a JSON object.");
      }
      return parsed as RegionDocument;
    }

    const { data, body } = parseFrontmatter(source, path);
    if (collection.body) {
      const field = collection.fields[collection.body];
      data[collection.body] = field?.type === "richtext" ? { html: body.trim() } : body.trim();
    }
    return data;
  } catch (error) {
    return new SpecIssue({
      code: "unreadable_content",
      file: path,
      message: (error as Error).message.replace(`${path}: `, ""),
      fix: collection.format === "markdown" ? "Check the YAML frontmatter." : "Fix the JSON.",
    });
  }
}

/** Walks a document for `src` values that came from a media upload. */
function collectMedia(
  found: Map<string, { file: string; path: string }>,
  file: string,
  document: RegionDocument,
  fields: Record<string, FieldDef> | null,
  schema: CmsSchema,
): void {
  if (fields) {
    walkFields(fields, document, "");
    return;
  }

  // A blocks region: each block declares its own type, and therefore its fields.
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  blocks.forEach((block, index) => {
    const type = (block as { _type?: unknown })?._type;
    const def = typeof type === "string" ? schema.blocks[type] : undefined;
    if (def && isObject(block)) walkFields(def.fields, block, `blocks[${index}]`);
  });

  function walkFields(defs: Record<string, FieldDef>, value: unknown, base: string): void {
    if (!isObject(value)) return;
    for (const [name, def] of Object.entries(defs)) {
      walk(def, value[name], base ? `${base}.${name}` : name);
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
    if (def.type !== "image" && def.type !== "file") return;

    const src = (value as { src?: unknown }).src;
    if (typeof src === "string" && src !== "" && !found.has(src)) found.set(src, { file, path });
  }
}

/** Maps a public media URL back to the file it must have been committed as. */
function mediaFileFor(config: CmsConfig, src: string): string | null {
  const prefix = `${config.mediaUrlPrefix.replace(/\/+$/, "")}/`;
  if (!src.startsWith(prefix)) return null; // an external URL is not ours to check
  return `${trimSlashes(config.content.media)}/${src.slice(prefix.length)}`;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

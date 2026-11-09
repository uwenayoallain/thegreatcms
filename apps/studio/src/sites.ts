/** Talking to a managed repository. */

import {
  type FieldDef,
  collectionEntryPath,
  DEFAULT_CONFIG,
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
  type CollectionDef,
  type CmsConfig,
  type CmsSchema,
  fieldDefaults,
  mediaFilePath,
  parseConfig,
  parseRegionFile,
  parseSchema,
  regionFilePath,
  regionIdFromPath,
  resolveRegion,
  serializeRegion,
  type RegionDocument,
  entryExtension,
  type CollectionFormat,
} from "@greatcms/spec";
import { marked } from "marked";
import type { Site } from "./db.js";
import {
  type Author,
  type HistoryEntry,
  LocalRepository,
  type CommitResult,
  type FileChange,
  type PushResult,
  type SyncState,
  type BranchState,
} from "./repo.js";

const SCHEMA_CANDIDATES = [".cms/schema.yaml", ".cms/schema.yml", ".cms/schema.json"];
const CONFIG_CANDIDATES = [".cms/config.yaml", ".cms/config.yml", ".cms/config.json"];

/** A region or entry, named the way the editor names it. */
export interface ContentTarget {
  label: string;
  href: string;
  /** Relative to the site page: `regions/home.hero` or `collections/posts/hello`. */
  target: string;
}

export interface UnsavedDraft extends ContentTarget {
  /** Repo-relative path of the content file this draft stands in for. */
  path: string;
}

/** A commit that changed content, with what it changed. */
export interface ContentChange extends HistoryEntry {
  touched: Array<ContentTarget & { removed: boolean }>;
}

/** What changed lately, and when each region or entry was last committed to. */
export interface Activity {
  recent: ContentChange[];
  /** Keyed by target, plus `collections/<name>` for the newest change in a collection. */
  edited: Map<string, { author: string; date: string }>;
}

export interface CollectionEntry {
  slug: string;
  /** Repo-relative path of the entry. */
  path: string;
  data: RegionDocument;
}

export interface SiteContext {
  schema: CmsSchema;
  config: CmsConfig;
  /** Head of the publish branch when the context was loaded. */
  headSha: string;
}

/** What an entry is called in a list: its slug field, a title or name, or the slug itself. */
export function entryTitle(
  collection: CollectionDef | undefined,
  data: Record<string, unknown>,
  slug: string,
): string {
  for (const key of [collection?.slug ?? "title", "title", "name"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return slug;
}

export class SiteNotConfiguredError extends Error {
  constructor(site: Site) {
    super(
      `${site.path} has no .cms/schema.yaml.\n  fix: add one: see SPEC.md, or run \`greatcms init\` in that folder: then reload this page.`,
    );
    this.name = "SiteNotConfiguredError";
  }
}

/**
 * Parsed schemas and configs by their exact text: every request reads the files, and parsing
 * the YAML again was half of what an editor page cost. Read-only; nothing changes a parsed one.
 */
const parsed = new Map<string, unknown>();
const MAX_PARSED = 64;

function parsedOnce<T>(file: { path: string; content: string }, parse: () => T): T {
  const key = `${file.path}\0${file.content}`;
  if (parsed.has(key)) return parsed.get(key) as T;
  // A schema that does not parse throws here, and nothing is remembered for it.
  const value = parse();
  if (parsed.size >= MAX_PARSED) parsed.clear();
  parsed.set(key, value);
  return value;
}

export class SiteClient {
  private readonly repo: LocalRepository;

  constructor(private readonly site: Site) {
    this.repo = new LocalRepository(site.path);
  }

  /** Where the files are, for messages that need to say. */
  get location(): string {
    return this.site.path;
  }

  /**
   * The schema and config, read fresh every time.
   *
   * Not cached on purpose. This is a working copy: `.cms/schema.yaml` changes
   * when you edit it, which does not move HEAD, so anything keyed on the commit
   * would hand back a schema you had already changed. Reading six small files
   * off local disk costs less than being wrong about that.
   */
  async context(): Promise<SiteContext> {
    const [schemaFile, configFile, headSha] = await Promise.all([
      this.firstFile(SCHEMA_CANDIDATES),
      this.firstFile(CONFIG_CANDIDATES),
      this.repo.getHead(),
    ]);

    if (!schemaFile) throw new SiteNotConfiguredError(this.site);

    return {
      schema: parsedOnce(schemaFile, () =>
        parseSchema(schemaFile.content, { file: schemaFile.path }),
      ),
      config: configFile
        ? parsedOnce(configFile, () => parseConfig(configFile.content, configFile.path))
        : DEFAULT_CONFIG,
      headSha,
    };
  }

  /** How far the working copy is ahead of its upstream. */
  syncState(): Promise<SyncState | null> {
    return this.repo.syncState();
  }

  branchState(): Promise<BranchState> {
    return this.repo.branchState();
  }

  switchBranch(name: string): Promise<void> {
    return this.repo.switchBranch(name);
  }

  push(): Promise<PushResult> {
    return this.repo.push();
  }

  /** A committed upload's bytes, by its file name in the media folder. */
  async mediaFile(context: SiteContext, fileName: string): Promise<Uint8Array | null> {
    return this.repo.getBytes(
      mediaFilePath(context.config, fileName),
      context.config.content.media,
    );
  }

  /** The stored document for a region, or null when nobody has edited it yet. */
  async readRegion(context: SiteContext, regionId: string): Promise<RegionDocument | null> {
    const path = regionFilePath(context.config, regionId);
    const file = await this.repo.getFile(path);
    return file ? parseRegionFile(file.content, path) : null;
  }

  /** Stored content layered over schema defaults: what the editor shows. */
  async resolvedRegion(context: SiteContext, regionId: string): Promise<RegionDocument> {
    const stored = await this.readRegion(context, regionId);
    return resolveRegion(context.schema, regionId, stored) ?? {};
  }

  /** Entries in a collection, newest-looking first. */
  async listEntries(context: SiteContext, name: string): Promise<CollectionEntry[]> {
    const collection = this.collection(context, name);
    const paths = await this.repo.listDirectory(collection.path);
    const extension = `.${entryExtension(collection.format)}`;

    const entries = await Promise.all(
      paths
        .filter((path) => path.endsWith(extension))
        .map(async (path) => {
          const file = await this.repo.getFile(path);
          if (!file) return null;
          return this.parseEntry(collection, path, file.content);
        }),
    );

    return entries
      .filter((entry): entry is CollectionEntry => entry !== null)
      .toSorted(
        (a, b) =>
          String(b.data.date ?? "").localeCompare(String(a.data.date ?? "")) ||
          a.slug.localeCompare(b.slug),
      );
  }

  /** How many entries a collection has, without reading them. */
  async entryCount(context: SiteContext, name: string): Promise<number> {
    const collection = this.collection(context, name);
    const extension = `.${entryExtension(collection.format)}`;
    const paths = await this.repo.listDirectory(collection.path);
    return paths.filter((path) => path.endsWith(extension)).length;
  }

  async readEntry(
    context: SiteContext,
    name: string,
    slug: string,
  ): Promise<CollectionEntry | null> {
    const collection = this.collection(context, name);
    const path = collectionEntryPath(context.config, collection, slug);
    const file = await this.repo.getFile(path);
    return file ? this.parseEntry(collection, path, file.content) : null;
  }

  /** The document an editor sees: stored values over schema defaults. */
  entryDocument(context: SiteContext, name: string, entry: CollectionEntry | null): RegionDocument {
    const collection = this.collection(context, name);
    const defaults = fieldDefaults(collection.fields);
    return { ...defaults, ...entry?.data };
  }

  /** Derives the file name for a new entry from its slug field. */
  entrySlug(context: SiteContext, name: string, document: RegionDocument): string {
    const collection = this.collection(context, name);
    const source = collection.slug ? document[collection.slug] : undefined;
    return slugify(String(source ?? document.title ?? "untitled"));
  }

  entryFile(
    context: SiteContext,
    name: string,
    slug: string,
    document: RegionDocument,
  ): {
    path: string;
    content: string;
  } {
    const collection = this.collection(context, name);
    const path = collectionEntryPath(context.config, collection, slug);

    if (collection.format === "json") {
      return { path, content: serializeRegion(document) };
    }

    // The body field is the Markdown body, which is what every generator expects.
    const data = { ...document };
    let body = "";
    if (collection.body) {
      const value = data[collection.body];
      body = typeof value === "string" ? value : String((value as { html?: string })?.html ?? "");
      delete data[collection.body];
    }
    return { path, content: serializeFrontmatter(data, body) };
  }

  collection(context: SiteContext, name: string): CollectionDef {
    const collection = context.schema.collections[name];
    if (!collection) {
      throw new Error(
        `Unknown collection "${name}".\n  fix: add it under \`collections:\` in .cms/schema.yaml.`,
      );
    }
    return collection;
  }

  private parseEntry(collection: CollectionDef, path: string, source: string): CollectionEntry {
    const slug = stripExtension(path.split("/").pop() ?? path, collection.format);

    if (collection.format === "json") {
      return { slug, path, data: JSON.parse(source) as RegionDocument };
    }

    const { data, body } = parseFrontmatter(source, path);
    if (collection.body) {
      // The body carries the shape its field type declares: richtext is an object. A Markdown body
      // written by hand becomes the HTML the editor works in; HTML the studio wrote passes through.
      const field = collection.fields[collection.body];
      const text = body.trim();
      data[collection.body] =
        field?.type !== "richtext"
          ? text
          : { html: collection.format === "markdown" ? markdownToHtml(text) : text };
    }
    return { slug, path, data };
  }

  async publishEntry(options: {
    context: SiteContext;
    name: string;
    slug: string;
    document: RegionDocument;
    actor?: string;
    author?: Author;
    expectedHeadSha?: string;
    /** Uploads, committed atomically with the entry that references them. */
    media?: FileChange[];
  }): Promise<CommitResult> {
    const { context, name, slug, document, expectedHeadSha } = options;
    const file = this.entryFile(context, name, slug, document);

    return this.repo.commitFiles({
      message: context.config.publish.commitMessage.replace("{summary}", `${name}/${slug}`),
      files: [...(options.media ?? []), file],
      expectedHeadSha,
      author: options.author,
    });
  }

  async deleteEntry(options: {
    context: SiteContext;
    name: string;
    slug: string;
    actor?: string;
    author?: Author;
  }): Promise<CommitResult> {
    const { context, name, slug } = options;
    const collection = this.collection(context, name);
    return this.repo.commitFiles({
      message: `content: remove ${name}/${slug}`,
      files: [{ path: collectionEntryPath(context.config, collection, slug), delete: true }],
      author: options.author,
    });
  }

  /** Writes what is currently in the editor to `.cms/draft/`, where the site's own dev server reads it. */
  async writeLiveDraft(options: {
    context: SiteContext;
    regionId?: string;
    collection?: { name: string; slug: string };
    document: RegionDocument;
    /** The commit the editor loaded, so a later publish of this draft is checked against it. */
    base?: string;
  }): Promise<boolean> {
    const { path, content } = this.contentFile(options);
    await this.repo.writeDraft(path, content, options.base);
    return true;
  }

  /** Entries of every collection a reference field points at, by slug and title, to choose from. */
  async referenceChoices(
    context: SiteContext,
  ): Promise<Record<string, Array<{ slug: string; title: string }>>> {
    const wanted = new Set<string>();
    const walk = (fields: Record<string, FieldDef>) => {
      for (const def of Object.values(fields)) {
        if (def.type === "reference") wanted.add(def.collection);
        else if (def.type === "group") walk(def.fields);
        else if (def.type === "list") walk({ item: def.of });
      }
    };
    for (const region of Object.values(context.schema.regions)) {
      if ("fields" in region) walk(region.fields);
    }
    for (const block of Object.values(context.schema.blocks)) walk(block.fields);
    for (const collection of Object.values(context.schema.collections)) walk(collection.fields);

    const names = [...wanted].filter((name) => context.schema.collections[name]);
    const lists = await Promise.all(names.map((name) => this.listEntries(context, name)));
    return Object.fromEntries(
      names.map((name, index) => {
        const collection = context.schema.collections[name];
        return [
          name,
          (lists[index] ?? []).map((entry) => ({
            slug: entry.slug,
            title: entryTitle(collection, entry.data, entry.slug),
          })),
        ];
      }),
    );
  }

  /** The images already in the media folder, as the URLs content stores, for reuse. */
  async mediaChoices(context: SiteContext): Promise<string[]> {
    const dir = context.config.content.media.replace(/\/+$/, "");
    const prefix = context.config.mediaUrlPrefix.replace(/\/+$/, "");
    const files = await this.repo.listDirectory(dir);
    return files
      .map((path) => path.slice(dir.length + 1))
      .filter((name) => /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(name) && !name.startsWith("."))
      .toSorted()
      .map((name) => `${prefix}/${name}`);
  }

  /** Every commit that changed this content, newest first. */
  async contentHistory(options: {
    context: SiteContext;
    regionId?: string;
    collection?: { name: string; slug: string };
  }): Promise<HistoryEntry[]> {
    return this.repo.history(this.contentFile({ ...options, document: {} }).path);
  }

  /**
   * Puts the content as it was at `sha` into the editor as an unsaved edit, based on the current
   * commit. Restoring is then an ordinary publish: previewed first, validated, one commit.
   */
  async restoreToDraft(options: {
    context: SiteContext;
    regionId?: string;
    collection?: { name: string; slug: string };
    sha: string;
  }): Promise<boolean> {
    const { context, regionId, collection, sha } = options;
    const { path } = this.contentFile({ ...options, document: {} });
    const source = await this.repo.fileAt(sha, path);
    if (source === null) return false;
    const document = regionId
      ? parseRegionFile(source, path)
      : collection
        ? this.parseEntry(this.collection(context, collection.name), path, source).data
        : null;
    if (!document) return false;
    return this.writeLiveDraft({ context, regionId, collection, document, base: context.headSha });
  }

  /**
   * Where an unsaved edit stands: the commit it started from, and whether the published file
   * changed since. The editor hands that commit back to the form, so publishing a stale draft
   * is refused instead of quietly overwriting someone else's change.
   */
  async liveDraftBase(options: {
    context: SiteContext;
    regionId?: string;
    collection?: { name: string; slug: string };
  }): Promise<{ base: string; stale: boolean } | null> {
    const { path } = this.contentFile({ ...options, document: {} });
    const base = await this.repo.readDraftBase(path);
    if (!base) return null;
    return { base, stale: await this.repo.changedSince(base, path) };
  }

  /**
   * The unsaved edit for a region or entry, as a document, or null when there is
   * none. An editor that ignored it would show one thing while the site shows
   * another, and publish would quietly discard what was typed.
   */
  async readLiveDraft(options: {
    context: SiteContext;
    regionId?: string;
    collection?: { name: string; slug: string };
  }): Promise<RegionDocument | null> {
    const { context, regionId, collection } = options;
    const { path } = this.contentFile({ ...options, document: {} });
    const source = await this.repo.readDraft(path);
    if (source === null) return null;
    if (regionId) return parseRegionFile(source, path);
    if (!collection) return null;
    return this.parseEntry(this.collection(context, collection.name), path, source).data;
  }

  /**
   * Unsaved edits waiting in the working copy, named the way the editor names
   * them. A draft nobody can see is a site quietly rendering something that was
   * never published.
   */
  async listLiveDrafts(context: SiteContext): Promise<UnsavedDraft[]> {
    const paths = await this.repo.listDrafts();
    return paths
      .flatMap((path) => {
        const found = this.targetOf(context, path);
        return found ? [{ ...found, path }] : [];
      })
      .toSorted((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Commits that changed this site's content, newest first, read from Git so a
   * change made outside the studio shows up too.
   */
  async activity(context: SiteContext, shown = 8): Promise<Activity> {
    const folders = [
      context.config.content.regions,
      ...Object.values(context.schema.collections).map((collection) => collection.path),
    ].map((folder) => folder.replace(/^\/+|\/+$/g, ""));
    const changes = await this.repo.changes([...new Set(folders)]);
    const edited = new Map<string, { author: string; date: string }>();
    const recent: ContentChange[] = [];

    for (const change of changes) {
      const touched: ContentChange["touched"] = [];
      for (const file of change.files) {
        const found = this.targetOf(context, file.path);
        if (!found) continue;
        touched.push({ ...found, removed: file.removed });
        const stamp = { author: change.author, date: change.date };
        if (!edited.has(found.target)) edited.set(found.target, stamp);
        const collection = found.target.match(/^collections\/[^/]+/)?.[0];
        if (collection && !edited.has(collection)) edited.set(collection, stamp);
      }
      if (touched.length > 0 && recent.length < shown) recent.push({ ...change, touched });
    }
    return { recent, edited };
  }

  /** Which region or collection entry a content path belongs to, if any. */
  private targetOf(context: SiteContext, path: string): ContentTarget | null {
    const regionId = regionIdFromPath(context.config, path);
    if (regionId && context.schema.regions[regionId]) {
      const target = `regions/${regionId}`;
      return {
        label: context.schema.regions[regionId].label ?? regionId,
        href: `/sites/${this.site.id}/${target}`,
        target,
      };
    }
    for (const [name, collection] of Object.entries(context.schema.collections)) {
      const dir = `${collection.path.replace(/^\/+|\/+$/g, "")}/`;
      if (!path.startsWith(dir) || path.slice(dir.length).includes("/")) continue;
      const extension = `.${entryExtension(collection.format)}`;
      if (!path.endsWith(extension)) continue;
      const slug = stripExtension(path.slice(dir.length), collection.format);
      const target = `collections/${name}/${encodeURIComponent(slug)}`;
      return {
        label: `${collection.label ?? name}: ${slug}`,
        href: `/sites/${this.site.id}/${target}`,
        target,
      };
    }
    return null;
  }

  /** Drops the draft, once its content is published or the edit is abandoned. */
  async clearLiveDraft(options: {
    context: SiteContext;
    regionId?: string;
    collection?: { name: string; slug: string };
  }): Promise<void> {
    await this.repo.clearDraft(this.contentFile({ ...options, document: {} }).path);
  }

  /** The file a document belongs in, and the bytes that would be written to it. */
  private contentFile(options: {
    context: SiteContext;
    regionId?: string;
    collection?: { name: string; slug: string };
    document: RegionDocument;
  }): { path: string; content: string } {
    const { context, regionId, collection, document } = options;
    if (regionId) {
      return {
        path: regionFilePath(context.config, regionId),
        content: serializeRegion(document),
      };
    }
    if (!collection) throw new Error("A draft needs a region or a collection entry.");
    const file = this.entryFile(context, collection.name, collection.slug, document);
    return { path: file.path, content: file.content ?? "" };
  }

  async publishRegion(options: {
    context: SiteContext;
    regionId: string;
    document: RegionDocument;
    actor?: string;
    author?: Author;
    expectedHeadSha?: string;
    /** Uploads, committed atomically with the content that references them. */
    media?: FileChange[];
  }): Promise<CommitResult> {
    const { context, regionId, document, actor, expectedHeadSha } = options;
    const path = regionFilePath(context.config, regionId);

    const content = serializeRegion(document, {
      updatedAt: new Date().toISOString(),
      updatedBy: actor ?? "studio",
      version: context.schema.version,
    });

    const message = context.config.publish.commitMessage.replace("{summary}", regionId);

    const result = await this.repo.commitFiles({
      message,
      // One commit: the image and the JSON pointing at it land together, or neither.
      files: [...(options.media ?? []), { path, content }],
      expectedHeadSha,
      author: options.author,
    });

    return result;
  }

  /** Tries every spelling at once and keeps the first that exists, in the order given. */
  private async firstFile(candidates: string[]): Promise<{ path: string; content: string } | null> {
    const found = await Promise.all(
      candidates.map(async (path) => {
        const file = await this.repo.getFile(path);
        return file ? { path, content: file.content } : null;
      }),
    );
    return found.find((entry) => entry !== null) ?? null;
  }
}

/** A file name back to the slug it came from, for whatever format stores it. */
function stripExtension(name: string, format: CollectionFormat): string {
  const suffix = `.${entryExtension(format)}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

/** Markdown the way the sites render it, so the editor opens on what a visitor reads. */
function markdownToHtml(text: string): string {
  return text === "" ? "" : marked.parse(text, { async: false, gfm: true }).trim();
}

/** Talking to a managed repository. */

import {
  collectionEntryPath,
  DEFAULT_CONFIG,
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
  type CollectionDef,
  type CmsConfig,
  type CmsSchema,
  fieldDefaults,
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
import type { Site } from "./db.js";
import { LocalRepository, type CommitResult, type FileChange } from "./repo.js";

const SCHEMA_CANDIDATES = [".cms/schema.yaml", ".cms/schema.yml", ".cms/schema.json"];
const CONFIG_CANDIDATES = [".cms/config.yaml", ".cms/config.yml", ".cms/config.json"];

export interface UnsavedDraft {
  label: string;
  href: string;
  /** Repo-relative path of the content file this draft stands in for. */
  path: string;
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

export class SiteNotConfiguredError extends Error {
  constructor(site: Site) {
    super(
      `${site.path} has no .cms/schema.yaml.\n  fix: add one — see SPEC.md, or run \`greatcms init\` in that folder — then reload this page.`,
    );
    this.name = "SiteNotConfiguredError";
  }
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
      schema: parseSchema(schemaFile.content, { file: schemaFile.path }),
      config: configFile ? parseConfig(configFile.content, configFile.path) : DEFAULT_CONFIG,
      headSha,
    };
  }

  /** The stored document for a region, or null when nobody has edited it yet. */
  async readRegion(context: SiteContext, regionId: string): Promise<RegionDocument | null> {
    const path = regionFilePath(context.config, regionId);
    const file = await this.repo.getFile(path);
    return file ? parseRegionFile(file.content, path) : null;
  }

  /** Stored content layered over schema defaults — what the editor shows. */
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
      return { path, content: `${JSON.stringify(document, null, 2)}\n` };
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
      // The body carries the shape its field type declares: richtext is an object.
      const field = collection.fields[collection.body];
      data[collection.body] = field?.type === "richtext" ? { html: body.trim() } : body.trim();
    }
    return { slug, path, data };
  }

  async publishEntry(options: {
    context: SiteContext;
    name: string;
    slug: string;
    document: RegionDocument;
    actor?: string;
    expectedHeadSha?: string;
  }): Promise<CommitResult> {
    const { context, name, slug, document, expectedHeadSha } = options;
    const file = this.entryFile(context, name, slug, document);

    return this.repo.commitFiles({
      message: context.config.publish.commitMessage.replace("{summary}", `${name}/${slug}`),
      files: [file],
      expectedHeadSha,
    });
  }

  async deleteEntry(options: {
    context: SiteContext;
    name: string;
    slug: string;
    actor?: string;
  }): Promise<CommitResult> {
    const { context, name, slug } = options;
    const collection = this.collection(context, name);
    return this.repo.commitFiles({
      message: `content: remove ${name}/${slug}`,
      files: [{ path: collectionEntryPath(context.config, collection, slug), delete: true }],
    });
  }

  /** Writes what is currently in the editor to `.cms/draft/`, where the site's own dev. */
  async writeLiveDraft(options: {
    context: SiteContext;
    regionId?: string;
    collection?: { name: string; slug: string };
    document: RegionDocument;
  }): Promise<boolean> {
    const { path, content } = this.contentFile(options);
    await this.repo.writeDraft(path, content);
    return true;
  }

  /**
   * Unsaved edits waiting in the working copy, named the way the editor names
   * them. A draft nobody can see is a site quietly rendering something that was
   * never published.
   */
  async listLiveDrafts(context: SiteContext): Promise<UnsavedDraft[]> {
    const paths = await this.repo.listDrafts();
    const drafts: UnsavedDraft[] = [];

    for (const path of paths) {
      const regionId = regionIdFromPath(context.config, path);
      if (regionId && context.schema.regions[regionId]) {
        const region = context.schema.regions[regionId];
        drafts.push({
          label: region.label ?? regionId,
          href: `/sites/${this.site.id}/regions/${regionId}`,
          path,
        });
        continue;
      }

      const entry = this.entryFromPath(context, path);
      if (entry) drafts.push(entry);
    }

    return drafts.toSorted((a, b) => a.label.localeCompare(b.label));
  }

  /** Which collection entry a path belongs to, if it belongs to one at all. */
  private entryFromPath(context: SiteContext, path: string): UnsavedDraft | null {
    for (const [name, collection] of Object.entries(context.schema.collections)) {
      const dir = `${collection.path.replace(/\/+$/, "")}/`;
      if (!path.startsWith(dir)) continue;
      const slug = stripExtension(path.slice(dir.length), collection.format);
      return {
        label: `${collection.label ?? name} — ${slug}`,
        href: `/sites/${this.site.id}/collections/${name}/${slug}`,
        path,
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

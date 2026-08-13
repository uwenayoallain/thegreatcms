/**
 * Talking to a managed repository.
 *
 * The studio reads three things over the GitHub API — the schema, the config,
 * and content files — and writes content back. It never executes anything from
 * the repository, which is what lets one studio manage a Hugo site, an Astro
 * site, and a Laravel site with the same code path.
 */

import { GitHubClient, type CommitResult, type PullRequest } from "@greatcms/git";
import type { FileChange } from "@greatcms/git";
import {
  DEFAULT_CONFIG,
  type CmsConfig,
  type CmsSchema,
  parseConfig,
  parseRegionFile,
  parseSchema,
  regionFilePath,
  resolveRegion,
  serializeRegion,
  type RegionDocument,
} from "@greatcms/spec";
import type { Site } from "./db.js";

const SCHEMA_CANDIDATES = [".cms/schema.yaml", ".cms/schema.yml", ".cms/schema.json"];
const CONFIG_CANDIDATES = [".cms/config.yaml", ".cms/config.yml", ".cms/config.json"];

export interface SiteContext {
  schema: CmsSchema;
  config: CmsConfig;
  /** Head of the publish branch when the context was loaded. */
  headSha: string;
}

export class SiteNotConfiguredError extends Error {
  constructor(site: Site) {
    super(
      `${site.owner}/${site.repo} has no .cms/schema.yaml on ${site.branch}.\n  fix: add one to the repository — see SPEC.md — then reload this page.`,
    );
    this.name = "SiteNotConfiguredError";
  }
}

export class SiteClient {
  private readonly github: GitHubClient;
  private readonly repo: { owner: string; repo: string };

  constructor(
    private readonly site: Site,
    fetchImpl?: typeof globalThis.fetch,
  ) {
    this.github = new GitHubClient({ token: site.token, fetch: fetchImpl });
    this.repo = { owner: site.owner, repo: site.repo };
  }

  /**
   * Loads the schema fresh on every request rather than caching it. A schema
   * change is a code change, and an editor seeing a stale form is worse than
   * one extra API call.
   */
  async context(): Promise<SiteContext> {
    const [schemaFile, configFile, headSha] = await Promise.all([
      this.firstFile(SCHEMA_CANDIDATES),
      this.firstFile(CONFIG_CANDIDATES),
      this.github.getBranchHead(this.repo, this.site.branch),
    ]);

    if (!schemaFile) throw new SiteNotConfiguredError(this.site);
    if (!headSha) {
      throw new Error(
        `Branch "${this.site.branch}" does not exist in ${this.site.owner}/${this.site.repo}.`,
      );
    }

    return {
      schema: parseSchema(schemaFile.content, { file: schemaFile.path }),
      config: configFile ? parseConfig(configFile.content, configFile.path) : DEFAULT_CONFIG,
      headSha,
    };
  }

  /** The stored document for a region, or null when nobody has edited it yet. */
  async readRegion(context: SiteContext, regionId: string): Promise<RegionDocument | null> {
    const path = regionFilePath(context.config, regionId);
    const file = await this.github.getFile(this.repo, path, this.site.branch);
    return file ? parseRegionFile(file.content, path) : null;
  }

  /** Stored content layered over schema defaults — what the editor shows. */
  async resolvedRegion(context: SiteContext, regionId: string): Promise<RegionDocument> {
    const stored = await this.readRegion(context, regionId);
    return resolveRegion(context.schema, regionId, stored) ?? {};
  }

  /**
   * Saves to a draft branch instead of the publish branch, so the site's own CI
   * builds a preview. This is the only preview approach that works for every
   * stack — the studio cannot render a Hugo site, and pretending otherwise
   * would mean a preview that lies.
   */
  async saveDraft(options: {
    context: SiteContext;
    regionId: string;
    document: RegionDocument;
    actor?: string;
    /** Uploads that must land in the same commit as the content. */
    media?: FileChange[];
  }): Promise<{ branch: string; commit: CommitResult; previewUrl: string | null }> {
    const { context, regionId, document, actor } = options;
    const branch = `${context.config.publish.draftBranchPrefix}-${regionId}`.replace(
      /[^\w./-]/g,
      "-",
    );

    await this.github.ensureBranch(this.repo, branch, this.site.branch);

    const commit = await this.github.commitFiles(this.repo, {
      branch,
      message: `content(draft): ${regionId}`,
      files: [
        ...(options.media ?? []),
        {
          path: regionFilePath(context.config, regionId),
          content: serializeRegion(document, {
            updatedAt: new Date().toISOString(),
            updatedBy: actor ?? "studio",
            version: context.schema.version,
          }),
        },
      ],
    });

    const template = context.config.preview?.urlTemplate;
    return {
      branch,
      commit,
      previewUrl: template ? template.replaceAll("{branch}", branch) : null,
    };
  }

  /**
   * Publishes by proposing rather than committing: the change lands on a draft
   * branch and a pull request asks for it. Review, a CI preview build, and
   * revert-to-roll-back all come from the pull request rather than being
   * features this studio has to grow.
   */
  async proposeRegion(options: {
    context: SiteContext;
    regionId: string;
    document: RegionDocument;
    title: string;
    body: string;
    actor?: string;
    media?: FileChange[];
  }): Promise<{ commit: CommitResult; pullRequest: PullRequest; previewUrl: string | null }> {
    const draft = await this.saveDraft({
      context: options.context,
      regionId: options.regionId,
      document: options.document,
      actor: options.actor,
      media: options.media,
    });

    const pullRequest = await this.github.openOrUpdatePullRequest(this.repo, {
      head: draft.branch,
      base: this.site.branch,
      title: options.title,
      body: options.body,
    });

    return { commit: draft.commit, pullRequest, previewUrl: draft.previewUrl };
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

    const result = await this.github.commitFiles(this.repo, {
      branch: this.site.branch,
      message,
      // One commit: the image and the JSON pointing at it land together, or
      // neither does. A deploy between the two would build a broken page.
      files: [...(options.media ?? []), { path, content }],
      expectedHeadSha,
    });

    // Some pipelines watch pushes; others want an explicit event. Both are one
    // line here, and neither is required for the site to rebuild.
    const dispatchEvent = context.config.publish.dispatchEvent;
    if (dispatchEvent) {
      await this.github.dispatch(this.repo, dispatchEvent, { region: regionId });
    }

    return result;
  }

  /**
   * Tries every spelling at once and keeps the first that exists, in the order
   * given. Three parallel 404-able reads cost one round trip instead of three,
   * and the API budget is 5000 requests an hour — latency is the scarce thing
   * here, not calls.
   */
  private async firstFile(candidates: string[]): Promise<{ path: string; content: string } | null> {
    const found = await Promise.all(
      candidates.map(async (path) => {
        const file = await this.github.getFile(this.repo, path, this.site.branch);
        return file ? { path, content: file.content } : null;
      }),
    );
    return found.find((entry) => entry !== null) ?? null;
  }
}

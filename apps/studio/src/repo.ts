/**
 * Where a site's files live.
 *
 * The studio needs seven operations from a repository, and nothing about them
 * is specific to GitHub. Naming that interface lets a site be a folder on this
 * machine instead of a remote — which is the fast loop: the studio writes to
 * your working copy, your dev server notices, and you see your real components
 * update without a commit, a push, or a network round trip.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  ConflictError,
  GitHubClient,
  type CommitRequest,
  type CommitResult,
  type PullRequest,
  type RepoRef,
} from "@greatcms/git";

const run = promisify(execFile);

export interface Repository {
  readonly kind: "github" | "local";
  getFile(path: string, ref?: string): Promise<{ content: string; sha: string } | null>;
  listDirectory(path: string, ref?: string): Promise<string[]>;
  getBranchHead(branch: string): Promise<string | null>;
  commitFiles(request: CommitRequest): Promise<CommitResult>;
  ensureBranch(branch: string, from: string): Promise<string>;
  openOrUpdatePullRequest(request: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest>;
  dispatch(event: string, payload?: Record<string, unknown>): Promise<void>;
}

/** The remote case: a thin binding of the repository coordinates to the client. */
export class GitHubRepository implements Repository {
  readonly kind = "github" as const;
  private readonly client: GitHubClient;

  constructor(
    private readonly repo: RepoRef,
    token: string,
    fetchImpl?: typeof globalThis.fetch,
  ) {
    this.client = new GitHubClient({ token, fetch: fetchImpl });
  }

  getFile(path: string, ref?: string) {
    return this.client.getFile(this.repo, path, ref);
  }

  listDirectory(path: string, ref?: string) {
    return this.client.listDirectory(this.repo, path, ref);
  }

  getBranchHead(branch: string) {
    return this.client.getBranchHead(this.repo, branch);
  }

  commitFiles(request: CommitRequest) {
    return this.client.commitFiles(this.repo, request);
  }

  ensureBranch(branch: string, from: string) {
    return this.client.ensureBranch(this.repo, branch, from);
  }

  openOrUpdatePullRequest(request: { head: string; base: string; title: string; body: string }) {
    return this.client.openOrUpdatePullRequest(this.repo, request);
  }

  async dispatch(event: string, payload?: Record<string, unknown>) {
    await this.client.dispatch(this.repo, event, payload);
  }
}

export class LocalRepositoryError extends Error {
  constructor(message: string, fix?: string) {
    super(fix ? `${message}\n  fix: ${fix}` : message);
    this.name = "LocalRepositoryError";
  }
}

/**
 * A checkout on this machine.
 *
 * Publishing writes the files and, when the folder is a Git repository, makes a
 * commit — so the same history you would get from the remote path, minus the
 * network. When it is not a repository, the files are simply written; some
 * people just want a folder.
 */
export class LocalRepository implements Repository {
  readonly kind = "local" as const;

  constructor(private readonly root: string) {}

  async getFile(path: string): Promise<{ content: string; sha: string } | null> {
    try {
      const content = await readFile(this.absolute(path), "utf8");
      return { content, sha: `local:${path}` };
    } catch {
      return null;
    }
  }

  async listDirectory(path: string): Promise<string[]> {
    try {
      const entries = await readdir(this.absolute(path), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => `${path.replace(/\/+$/, "")}/${entry.name}`);
    } catch {
      return [];
    }
  }

  /**
   * The current commit, or a marker when this is not a repository. Either way
   * it is a value the editor can carry and compare, which is all the
   * conflict check needs.
   */
  async getBranchHead(): Promise<string | null> {
    const sha = await this.git(["rev-parse", "HEAD"]);
    return sha?.trim() ?? "working-copy";
  }

  async commitFiles(request: CommitRequest): Promise<CommitResult> {
    if (request.files.length === 0) {
      throw new LocalRepositoryError("A publish needs at least one file change.");
    }

    if (request.expectedHeadSha) {
      const head = await this.getBranchHead();
      if (head && head !== "working-copy" && head !== request.expectedHeadSha) {
        throw new ConflictError(request.branch, request.expectedHeadSha, head);
      }
    }

    // Writes happen together and before any commit, so a failure part-way
    // leaves the working copy inspectable rather than half-committed.
    await Promise.all(
      request.files.map(async (file) => {
        const target = this.absolute(file.path);
        if (file.delete) {
          await rm(target, { force: true });
          return;
        }
        await mkdir(dirname(target), { recursive: true });
        const content = file.base64
          ? Buffer.from(file.base64, "base64")
          : Buffer.from(file.content ?? "", "utf8");
        await writeFile(target, content);
      }),
    );

    const paths = request.files.map((file) => file.path);
    const staged = await this.git(["add", "--", ...paths]);
    if (staged === null) {
      // Not a Git repository: the files are written, and that is the whole job.
      return {
        commitSha: "working-copy",
        treeSha: "working-copy",
        branch: request.branch,
        url: `file://${this.root}`,
      };
    }

    // "Nothing to commit" is a success: what is on disk already matches.
    await this.git(["commit", "-m", request.message, "--", ...paths]);
    const sha = (await this.git(["rev-parse", "HEAD"]))?.trim() ?? "working-copy";

    return {
      commitSha: sha,
      treeSha: sha,
      branch: request.branch,
      url: `file://${this.root}`,
    };
  }

  async ensureBranch(): Promise<string> {
    // A working copy is already on the branch it is on; drafts here are just
    // files, and Git is the thing that remembers them.
    return (await this.getBranchHead()) ?? "working-copy";
  }

  async openOrUpdatePullRequest(): Promise<PullRequest> {
    throw new LocalRepositoryError(
      "A local folder cannot open a pull request.",
      "Set this site's publishing mode to direct, or connect it as a GitHub repository.",
    );
  }

  async dispatch(): Promise<void> {
    // Nothing to notify: there is no pipeline watching a folder.
  }

  /** Runs git, returning null when this is not a repository or the command fails. */
  private async git(args: string[]): Promise<string | null> {
    try {
      const { stdout } = await run("git", args, { cwd: this.root, maxBuffer: 8 * 1024 * 1024 });
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a repo-relative path, refusing anything that climbs out. The
   * studio writes wherever a schema says to, and a schema is a file in a
   * repository someone else may have written.
   */
  private absolute(path: string): string {
    const target = resolve(this.root, path);
    const inside = relative(this.root, target);
    if (inside.startsWith("..") || inside.startsWith(sep) || resolve(inside) === inside) {
      throw new LocalRepositoryError(
        `Refusing to touch ${path}: it resolves outside ${this.root}.`,
        "Content paths in .cms/config.yaml must stay inside the site.",
      );
    }
    return join(this.root, inside);
  }
}

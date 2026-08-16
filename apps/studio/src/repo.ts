/** Where a site's files live. */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DRAFT_DIR, draftFilePath } from "@greatcms/spec";

const run = promisify(execFile);

export interface FileChange {
  /** Repo-relative path, e.g. `content/cms/home.hero.json`. */
  path: string;
  /** UTF-8 text content. Mutually exclusive with `base64`. */
  content?: string;
  /** Base64 content, for binary files such as uploads. */
  base64?: string;
  /** Delete the path instead of writing it. */
  delete?: boolean;
}

export interface CommitRequest {
  message: string;
  files: FileChange[];
  /** The commit the editor started from. */
  expectedHeadSha?: string;
}

export interface CommitResult {
  commitSha: string;
  url: string;
}

/** Someone committed while the editor was open, so publishing would overwrite them. */
export class ConflictError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `The working copy moved while you were editing (expected ${short(expected)}, found ${short(actual)}).\n  fix: reload the region to pick up the newer content, then publish again.`,
    );
    this.name = "ConflictError";
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * The operations the studio needs from a site's files. One implementation
 * today; the interface stays because the editor, validation, and publish above
 * it must not know or care where the bytes are.
 */
export interface Repository {
  getFile(path: string): Promise<{ content: string; sha: string } | null>;
  listDirectory(path: string): Promise<string[]>;
  /** The current commit, or a marker when this is not a repository. */
  getHead(): Promise<string>;
  commitFiles(request: CommitRequest): Promise<CommitResult>;
}

export class LocalRepositoryError extends Error {
  constructor(message: string, fix?: string) {
    super(fix ? `${message}\n  fix: ${fix}` : message);
    this.name = "LocalRepositoryError";
  }
}

/** A checkout on this machine. */
export class LocalRepository implements Repository {
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

  async getHead(): Promise<string> {
    const sha = await this.git(["rev-parse", "HEAD"]);
    return sha?.trim() || "working-copy";
  }

  async commitFiles(request: CommitRequest): Promise<CommitResult> {
    if (request.files.length === 0) {
      throw new LocalRepositoryError("A publish needs at least one file change.");
    }

    if (request.expectedHeadSha) {
      const head = await this.getHead();
      if (head !== "working-copy" && head !== request.expectedHeadSha) {
        throw new ConflictError(request.expectedHeadSha, head);
      }
    }

    // Writes happen together and before any commit, so a failure part-way leaves the working.
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
      return { commitSha: "working-copy", url: `file://${this.root}` };
    }

    // "Nothing to commit" is a success: what is on disk already matches.
    await this.git(["commit", "-m", request.message, "--", ...paths]);
    return { commitSha: await this.getHead(), url: `file://${this.root}` };
  }

  /** Writes an unsaved edit where the site's dev server will read it. */
  async writeDraft(path: string, content: string): Promise<void> {
    const target = this.absolute(draftFilePath(path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(this.absolute(`${DRAFT_DIR}/.gitignore`), "*\n");
    await writeFile(target, content);
  }

  /** Drops a draft once its content is published, or when it is discarded. */
  async clearDraft(path: string): Promise<void> {
    await rm(this.absolute(draftFilePath(path)), { force: true });
  }

  async hasDraft(path: string): Promise<boolean> {
    return (await this.getFile(draftFilePath(path))) !== null;
  }

  /** Every content path with an unsaved edit waiting, so none can be forgotten. */
  async listDrafts(): Promise<string[]> {
    const walk = async (dir: string): Promise<string[]> => {
      let entries;
      try {
        entries = await readdir(this.absolute(dir), { withFileTypes: true });
      } catch {
        return [];
      }
      const found = await Promise.all(
        entries.map(async (entry) => {
          const path = `${dir}/${entry.name}`;
          if (entry.isDirectory()) return walk(path);
          return entry.name === ".gitignore" ? [] : [path.slice(DRAFT_DIR.length + 1)];
        }),
      );
      return found.flat();
    };
    return walk(DRAFT_DIR);
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

  /** Resolves a repo-relative path, refusing anything that climbs out. */
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

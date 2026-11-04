/** Where a site's files live. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DRAFT_DIR, draftFilePath } from "@greatcms/spec";

const run = promisify(execFile);

// The studio never executes anything from a managed repository, git hooks included.
const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** The publish in flight per site folder, so two never interleave writes, staging, or commits. */
const publishing = new Map<string, Promise<unknown>>();

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

export interface HistoryEntry {
  sha: string;
  author: string;
  /** ISO 8601, as git wrote it. */
  date: string;
  subject: string;
}

/** A commit with the files it changed, for a site's recent activity. */
export interface Change extends HistoryEntry {
  files: Array<{ path: string; removed: boolean }>;
}

export interface Author {
  name: string;
  email: string;
}

export interface CommitRequest {
  message: string;
  files: FileChange[];
  /** The person behind the change; without one, git's own configured identity is used. */
  author?: Author;
  /** The commit the editor started from. */
  expectedHeadSha?: string;
}

export interface CommitResult {
  commitSha: string;
  url: string;
}

/** Where the working copy stands against its upstream, or null when there is none to compare with. */
export interface SyncState {
  upstream: string;
  ahead: number;
}

export type PushResult = { ok: true; upstream: string } | { ok: false; reason: string };

/** The content being published changed after the editor loaded it, so publishing would overwrite that. */
export class ConflictError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    uncommitted = false,
  ) {
    super(
      uncommitted
        ? "This content has unsaved changes in the working copy that someone made outside the studio.\n  fix: commit or discard them, reload, then publish again."
        : `The working copy moved while you were editing (expected ${short(expected)}, found ${short(actual)}), and this content changed with it.\n  fix: reload to pick up the newer content, then publish again.`,
    );
    this.name = "ConflictError";
  }
}

/** Beside the drafts, out of the reader's way: `.cms/draft/.base/<path>` holds the commit a draft began at. */
const BASES = ".base";
const baseFile = (path: string) => `${DRAFT_DIR}/${BASES}/${path}`;

/** Angle brackets and newlines would let a name rewrite the author line git builds from it. */
const clean = (value: string) => value.replace(/[<>\n\r]/g, "").trim();

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

  /** A committed link could point anywhere on this machine, so a file is read only if it really lies inside. */
  async getFile(path: string): Promise<{ content: string; sha: string } | null> {
    const bytes = await this.getBytes(path);
    return bytes ? { content: Buffer.from(bytes).toString("utf8"), sha: `local:${path}` } : null;
  }

  /** A file's bytes, or null when it is missing or, once links are followed, outside `within`. */
  async getBytes(path: string, within = "."): Promise<Uint8Array | null> {
    try {
      const target = this.absolute(path);
      const [folder, real] = await Promise.all([realpath(this.absolute(within)), realpath(target)]);
      const inside = relative(folder, real);
      if (inside.startsWith("..") || resolve(inside) === inside) return null;
      return await readFile(real);
    } catch {
      return null;
    }
  }

  async listDirectory(path: string): Promise<string[]> {
    try {
      const folder = this.absolute(path);
      // A linked folder could list any directory on this machine; only one inside the site is read.
      if (!(await this.reallyInside(folder))) return [];
      const entries = await readdir(folder, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => `${path.replace(/\/+$/, "")}/${entry.name}`);
    } catch {
      return [];
    }
  }

  async getHead(): Promise<string> {
    const sha = await this.tryGit(["rev-parse", "HEAD"]);
    return sha?.trim() || "working-copy";
  }

  async commitFiles(request: CommitRequest): Promise<CommitResult> {
    const previous = publishing.get(this.root) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.commitNow(request));
    publishing.set(this.root, current);
    try {
      return await current;
    } finally {
      if (publishing.get(this.root) === current) publishing.delete(this.root);
    }
  }

  private async commitNow(request: CommitRequest): Promise<CommitResult> {
    if (request.files.length === 0) {
      throw new LocalRepositoryError("A publish needs at least one file change.");
    }

    if (request.expectedHeadSha) await this.assertUnchanged(request);

    // Every byte lands in a temporary file first, so a full disk or a bad path fails
    // before any real file has changed; the renames that follow replace each one whole.
    const targets = await Promise.all(request.files.map((file) => this.writable(file.path)));
    const temps = request.files.flatMap((file, index) => {
      if (file.delete) return [];
      const target = targets[index] as string;
      const content = file.base64
        ? Buffer.from(file.base64, "base64")
        : Buffer.from(file.content ?? "", "utf8");
      return [{ temp: `${target}.${randomUUID()}.tmp`, target, content }];
    });
    const results = await Promise.allSettled(
      temps.map(({ temp, content }) => writeFile(temp, content, { flag: "wx" })),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      await Promise.all(temps.map(({ temp }) => rm(temp, { force: true })));
      throw failed.reason;
    }
    await Promise.all(temps.map(({ temp, target }) => rename(temp, target)));
    await Promise.all(
      request.files.flatMap((file, index) =>
        file.delete ? [rm(targets[index] as string, { force: true })] : [],
      ),
    );

    const url = `file://${this.root}`;
    if ((await this.tryGit(["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") {
      // Not a Git repository: the files are written, and that is the whole job.
      return { commitSha: "working-copy", url };
    }

    const written = request.files.filter((file) => !file.delete).map((file) => file.path);
    const removed = request.files.filter((file) => file.delete).map((file) => file.path);
    if (written.length > 0) await this.git(["add", "--", ...written]);
    if (removed.length > 0)
      await this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...removed]);

    const paths = request.files.map((file) => file.path);
    const staged = (await this.git(["diff", "--cached", "--name-only", "-z", "--", ...paths]))
      .split("\0")
      .filter(Boolean);
    // "Nothing to commit" is a success: what is on disk already matches.
    if (staged.length === 0) return { commitSha: await this.getHead(), url };
    const author = request.author
      ? ["--author", `${clean(request.author.name)} <${clean(request.author.email)}>`]
      : [];
    await this.git(["commit", "--no-verify", ...author, "-m", request.message, "--", ...staged]);
    return { commitSha: await this.getHead(), url };
  }

  /**
   * Refuses a publish whose files changed since the editor loaded them. Only these files
   * count: a commit elsewhere in the repository is not a reason to stop an editor.
   */
  private async assertUnchanged(request: CommitRequest): Promise<void> {
    const expected = request.expectedHeadSha as string;
    const head = await this.getHead();
    if (head === "working-copy") return;
    const paths = request.files.map((file) => file.path);
    if (!isCommitId(expected)) throw new ConflictError(expected, head);
    // A non-zero exit is a difference, or a commit this repository no longer has.
    if (
      head !== expected &&
      (await this.tryGit([
        "diff",
        "--quiet",
        "--end-of-options",
        expected,
        head,
        "--",
        ...paths,
      ])) === null
    ) {
      throw new ConflictError(expected, head);
    }
    if ((await this.tryGit(["diff", "--quiet", "HEAD", "--", ...paths])) === null) {
      throw new ConflictError(expected, head, true);
    }
  }

  /** The branch's upstream and how many commits have not reached it, or null without one. */
  async syncState(): Promise<SyncState | null> {
    const upstream = (
      await this.tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    )?.trim();
    if (!upstream) return null;
    const ahead = Number((await this.tryGit(["rev-list", "--count", "@{u}..HEAD"]))?.trim() ?? "0");
    return { upstream, ahead: Number.isFinite(ahead) ? ahead : 0 };
  }

  /**
   * Pushes the current branch to its upstream. Queued behind any publish in flight, never
   * prompts for credentials (it would hang the request), and never runs a pre-push hook.
   */
  async push(): Promise<PushResult> {
    const previous = publishing.get(this.root) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.pushNow());
    publishing.set(this.root, current);
    try {
      return await current;
    } finally {
      if (publishing.get(this.root) === current) publishing.delete(this.root);
    }
  }

  private async pushNow(): Promise<PushResult> {
    const state = await this.syncState();
    if (!state) {
      return {
        ok: false,
        reason:
          "This branch has no upstream to push to.\n  fix: run `git push -u origin <branch>` once in the site's folder.",
      };
    }
    try {
      await run("git", [...SAFE_GIT, "push", "--porcelain"], {
        cwd: this.root,
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
      });
      return { ok: true, upstream: state.upstream };
    } catch (error) {
      const output = `${String((error as { stdout?: unknown }).stdout ?? "")}\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
      if (/\[rejected\]|non-fast-forward|fetch first/.test(output)) {
        return {
          ok: false,
          reason: `${state.upstream} has commits this copy does not.\n  fix: run \`git pull --rebase\` in the site's folder, then push again.`,
        };
      }
      const detail = output
        .split("\n")
        .map((line) => line.trim())
        .findLast(Boolean);
      return { ok: false, reason: `git push failed: ${detail ?? String(error)}` };
    }
  }

  /** Writes an unsaved edit where the site's dev server will read it, with the commit it started from. */
  async writeDraft(path: string, content: string, base?: string): Promise<void> {
    const target = await this.writable(draftFilePath(path));
    await writeFile(await this.writable(`${DRAFT_DIR}/.gitignore`), "*\n");
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { flag: "wx" });
    await rename(temp, target);
    if (base) await writeFile(await this.writable(baseFile(path)), `${base}\n`);
  }

  /** Drops a draft once its content is published, or when it is discarded. */
  async clearDraft(path: string): Promise<void> {
    await rm(await this.writable(draftFilePath(path)), { force: true });
    await rm(await this.writable(baseFile(path)), { force: true });
  }

  /** Commits that touched a file, newest first; empty outside a Git repository. */
  async history(path: string, limit = 30): Promise<HistoryEntry[]> {
    const out = await this.tryGit([
      "log",
      `-n${limit}`,
      "--format=%H%x1f%an%x1f%aI%x1f%s",
      "--follow",
      "--",
      path,
    ]);
    if (!out) return [];
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", author = "", date = "", subject = ""] = line.split("\x1f");
        return { sha, author, date, subject };
      });
  }

  /** Recent commits under some folders, each with the files it touched; empty outside Git. */
  async changes(paths: string[], limit = 200): Promise<Change[]> {
    if (paths.length === 0) return [];
    for (const path of paths) this.absolute(path);
    const out = await this.tryGit([
      "log",
      `-n${limit}`,
      "--format=%x1e%H%x1f%an%x1f%aI%x1f%s",
      "--name-status",
      "--no-renames",
      "--relative",
      "--",
      ...paths,
    ]);
    if (!out) return [];
    return out
      .split("\x1e")
      .filter((record) => record.trim())
      .map((record) => {
        const [head = "", ...lines] = record.split("\n");
        const [sha = "", author = "", date = "", subject = ""] = head.split("\x1f");
        const files = lines.flatMap((line) => {
          const [status, path] = line.split("\t");
          return status && path ? [{ path, removed: status === "D" }] : [];
        });
        return { sha, author, date, subject, files };
      });
  }

  /** A file as it was at a commit, or null when it did not exist there. */
  async fileAt(sha: string, path: string): Promise<string | null> {
    if (!isCommitId(sha)) return null;
    this.absolute(path);
    return this.tryGit(["show", "--end-of-options", `${sha}:${path}`]);
  }

  /** The commit an unsaved edit started from, or null when it was not recorded. */
  async readDraftBase(path: string): Promise<string | null> {
    // The file sits in the managed repository, so it is data until it looks like a commit.
    const base = (await this.getFile(baseFile(path)))?.content.trim();
    return base && isCommitId(base) ? base : null;
  }

  /** Whether a content file was committed to after `base`: a draft from then would overwrite it. */
  async changedSince(base: string, path: string): Promise<boolean> {
    const head = await this.getHead();
    if (head === "working-copy" || head === base) return false;
    if (!isCommitId(base)) return true;
    return (
      (await this.tryGit(["diff", "--quiet", "--end-of-options", base, head, "--", path])) === null
    );
  }

  async hasDraft(path: string): Promise<boolean> {
    return (await this.getFile(draftFilePath(path))) !== null;
  }

  /** The unsaved edit for a content path, so the editor can pick up where it left off. */
  async readDraft(path: string): Promise<string | null> {
    return (await this.getFile(draftFilePath(path)))?.content ?? null;
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
          if (entry.isDirectory()) return entry.name === BASES ? [] : walk(path);
          return entry.name === ".gitignore" ? [] : [path.slice(DRAFT_DIR.length + 1)];
        }),
      );
      return found.flat();
    };
    return walk(DRAFT_DIR);
  }

  /** Runs git, returning null when this is not a repository or the command fails. */
  private async tryGit(args: string[]): Promise<string | null> {
    try {
      return await this.git(args);
    } catch {
      return null;
    }
  }

  /** Runs git where a failure is something the editor must see. */
  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await run("git", [...SAFE_GIT, ...args], {
        cwd: this.root,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      throw new LocalRepositoryError(
        `git ${args[0]} failed: ${stderr || String(error)}`,
        "Nothing was committed. Fix the repository, then publish again.",
      );
    }
  }

  /** Resolves a repo-relative path, refusing anything that climbs out. */
  /** Whether `path`, with every link followed, is the site's folder or inside it. */
  private async reallyInside(path: string): Promise<boolean> {
    try {
      const [root, real] = await Promise.all([realpath(this.root), realpath(path)]);
      const inside = relative(root, real);
      return !(inside.startsWith("..") || resolve(inside) === inside);
    } catch {
      return false;
    }
  }

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

  /**
   * A path that is safe to write or delete: its folder exists, really lies inside the
   * site once links are followed, and the file itself is not a link to somewhere else.
   */
  private async writable(path: string): Promise<string> {
    const target = this.absolute(path);
    // Checked before anything is created, so a linked folder cannot have one made outside the site.
    if (!(await this.reallyInside(await nearestExisting(dirname(target))))) {
      throw new LocalRepositoryError(
        `Refusing to write ${path}: a symbolic link points it outside ${this.root}.`,
        "Replace the link with a real folder or file inside the site.",
      );
    }
    await mkdir(dirname(target), { recursive: true });
    const linked = await lstat(target).then(
      (stat) => stat.isSymbolicLink(),
      () => false,
    );
    if (!(await this.reallyInside(dirname(target))) || linked) {
      throw new LocalRepositoryError(
        `Refusing to write ${path}: a symbolic link points it outside ${this.root}.`,
        "Replace the link with a real folder or file inside the site.",
      );
    }
    return target;
  }
}

/** The path itself or its closest ancestor that exists, which is what a link would redirect. */
async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each step up is only needed if the last was missing
    const exists = await lstat(current).then(Boolean, () => false);
    if (exists) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** A full or abbreviated commit id, and nothing git could read as an option or a range. */
export function isCommitId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(value);
}

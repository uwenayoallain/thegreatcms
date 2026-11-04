/** Builds one commit in a clean checkout and swaps a symlink, so the live site is always a whole build. */

import { execFile, spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// The source may be a repository the studio writes into; nothing in it may run here.
const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export interface DeployOptions {
  /** A repository: a path on this machine, or a URL git can clone. */
  source: string;
  branch: string;
  /** Holds `releases/<sha>`, `current` and `status.json`. */
  root: string;
  /** Shell command run inside the checkout. */
  build: string;
  /** Folder the build writes, relative to the checkout. */
  output: string;
  keep: number;
  /** Longest a build may take before it is killed, in milliseconds. */
  timeout?: number;
  log: (line: string) => void;
}

export interface Release {
  sha: string;
  message: string;
  at: string;
}

export interface Status {
  live?: Release;
  /** Rolled back by hand: this release stays live until the branch moves past `tip`. */
  pinned?: { sha: string; tip: string; at: string };
  /** The newest commit that would not build, until one does. */
  failed?: Release & { log: string };
  checkedAt: string;
}

export type Outcome =
  | { outcome: "deployed"; sha: string }
  | { outcome: "unchanged"; sha: string }
  | { outcome: "failed"; sha: string; log: string };

export function readStatus(root: string): Status | null {
  try {
    return JSON.parse(readFileSync(join(root, "status.json"), "utf8")) as Status;
  } catch {
    return null;
  }
}

export class Deployer {
  private busy: Promise<Outcome> | null = null;

  constructor(private readonly options: DeployOptions) {}

  /** Deploys the branch tip, or `sha`, unless it is already live. Calls queue rather than overlap. */
  once(sha?: string): Promise<Outcome> {
    const previous = this.busy ?? Promise.resolve();
    const current = previous.then(
      () => this.deploy(sha),
      () => this.deploy(sha),
    );
    this.busy = current;
    return current.finally(() => {
      if (this.busy === current) this.busy = null;
    });
  }

  /**
   * Puts an earlier release back live without building anything, and holds it there until
   * the next commit arrives: a rollback that the next check quietly undid would be no rollback.
   */
  async rollback(sha: string): Promise<boolean> {
    const { root, log } = this.options;
    const release = join(root, "releases", sha);
    if (!/^[0-9a-f]{40}$/.test(sha) || !existsSync(release)) return false;
    const status = readStatus(root) ?? { checkedAt: "" };
    this.swap(release);
    status.live = { sha, message: await this.subject(sha), at: new Date().toISOString() };
    status.pinned = { sha, tip: await this.tip(), at: status.live.at };
    this.writeStatus(status);
    log(`${sha.slice(0, 7)} rolled back to; held until the next commit`);
    return true;
  }

  /** A rollback the studio asked for by writing `rollback` into the root. */
  async takeRequest(): Promise<void> {
    const file = join(this.options.root, "rollback");
    if (!existsSync(file)) return;
    const sha = readFileSync(file, "utf8").trim();
    rmSync(file, { force: true });
    if (!(await this.rollback(sha)))
      this.options.log(`rollback to ${sha.slice(0, 7)} refused: no such release`);
  }

  /** The releases kept on disk, newest first, which are what a rollback can go back to. */
  releases(): string[] {
    const dir = join(this.options.root, "releases");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, at: statTime(join(dir, entry.name)) }))
      .toSorted((a, b) => b.at - a.at)
      .map((entry) => entry.name);
  }

  private async deploy(requested?: string): Promise<Outcome> {
    const { root, source, log } = this.options;
    mkdirSync(join(root, "releases"), { recursive: true });
    const status = readStatus(root) ?? { checkedAt: "" };
    const sha = requested ?? (await this.tip());
    // A full commit id and nothing else: never an option, a range, or a path for a release folder.
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      log(`refused to build ${JSON.stringify(sha.slice(0, 80))}: not a full commit id`);
      return { outcome: "failed", sha, log: "Not a full 40-character commit id." };
    }
    status.checkedAt = new Date().toISOString();

    if (!requested && status.pinned) {
      if (status.pinned.tip === sha) {
        this.writeStatus(status);
        return { outcome: "unchanged", sha: status.pinned.sha };
      }
      // Something new was published: the rollback has done its job.
      delete status.pinned;
    }

    if (status.live?.sha === sha) {
      this.writeStatus(status);
      return { outcome: "unchanged", sha };
    }

    const work = join(root, "work");
    rmSync(work, { recursive: true, force: true });
    const message = await this.subject(sha);
    log(`${sha.slice(0, 7)} ${message}: building`);
    try {
      await run("git", [...SAFE_GIT, "clone", "-q", "--no-checkout", source, work]);
      await run("git", [
        ...SAFE_GIT,
        "-C",
        work,
        "checkout",
        "-q",
        "--detach",
        "--end-of-options",
        sha,
      ]);
      await this.build(work);
      const release = join(root, "releases", sha);
      const output = resolve(work, this.options.output);
      // The output must be a folder the build made inside the checkout, not a way out of it.
      if (!output.startsWith(work + sep) || !statSync(output).isDirectory()) {
        throw new BuildError(
          `DEPLOY_OUTPUT ${this.options.output} is not a folder inside the checkout.`,
        );
      }
      rmSync(release, { recursive: true, force: true });
      renameSync(output, release);
      this.swap(release);
      status.live = { sha, message, at: new Date().toISOString() };
      delete status.failed;
      log(`${sha.slice(0, 7)} live`);
      this.prune(sha);
      return { outcome: "deployed", sha };
    } catch (error) {
      const detail = error instanceof BuildError ? error.output : String(error);
      status.failed = { sha, message, at: new Date().toISOString(), log: detail.slice(-8000) };
      log(
        `${sha.slice(0, 7)} failed; ${status.live ? `${status.live.sha.slice(0, 7)} stays live` : "nothing is live"}`,
      );
      return { outcome: "failed", sha, log: detail };
    } finally {
      rmSync(work, { recursive: true, force: true });
      this.writeStatus(status);
    }
  }

  private async tip(): Promise<string> {
    const { stdout } = await run("git", [
      ...SAFE_GIT,
      "ls-remote",
      this.options.source,
      `refs/heads/${this.options.branch}`,
    ]);
    const sha = stdout.split(/\s/)[0];
    if (!sha) throw new Error(`${this.options.source} has no branch "${this.options.branch}".`);
    return sha;
  }

  private async subject(sha: string): Promise<string> {
    try {
      const { stdout } = await run("git", [
        ...SAFE_GIT,
        "-C",
        this.options.source,
        "log",
        "-1",
        "--format=%s",
        "--end-of-options",
        sha,
      ]);
      return stdout.trim();
    } catch {
      return "";
    }
  }

  /** Runs the build command with its output captured, killed if it outlives the timeout. */
  private build(cwd: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("sh", ["-c", this.options.build], {
        cwd,
        env: { ...process.env, CI: "1" },
      });
      let output = "";
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-64_000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => child.kill("SIGKILL"), this.options.timeout ?? 15 * 60_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new BuildError(`${error.message}\n${output}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise(output);
        else reject(new BuildError(`${output}\nbuild exited with ${signal ?? `code ${code}`}`));
      });
    });
  }

  /** Points `current` at the release in one rename, so a visitor never sees a half-swapped site. */
  private swap(release: string): void {
    const temp = join(this.options.root, `.current.${process.pid}`);
    rmSync(temp, { force: true });
    // Relative, so `current` resolves wherever the folder is mounted: the web server's path need not match.
    symlinkSync(relative(this.options.root, release), temp);
    renameSync(temp, join(this.options.root, "current"));
  }

  private prune(live: string): void {
    const dir = join(this.options.root, "releases");
    const releases = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== live)
      .map((entry) => ({ name: entry.name, at: statTime(join(dir, entry.name)) }))
      .toSorted((a, b) => b.at - a.at);
    for (const release of releases.slice(Math.max(this.options.keep - 1, 0))) {
      rmSync(join(dir, release.name), { recursive: true, force: true });
    }
  }

  private writeStatus(status: Status): void {
    const file = join(this.options.root, "status.json");
    writeFileSync(`${file}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }
}

class BuildError extends Error {
  constructor(readonly output: string) {
    super("The build failed.");
  }
}

function statTime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

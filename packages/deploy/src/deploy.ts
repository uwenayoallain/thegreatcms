/** Builds one commit in a clean checkout and swaps a symlink, so the live site is always a whole build. */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  existsSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// The source may be a repository the studio writes into; nothing in it may run here.
const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
// A remote that wants a password is a failed check, not a prompt nobody will answer.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
const GIT_QUICK_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

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
  /** Another builder is at work in the same root; this one changed nothing. */
  | { outcome: "busy"; sha: string }
  | { outcome: "failed"; sha: string; log: string };

export function readStatus(root: string): Status | null {
  try {
    return JSON.parse(readFileSync(join(root, "status.json"), "utf8")) as Status;
  } catch {
    return null;
  }
}

interface Lock {
  pid: number;
  host: string;
  at: number;
}

function readLock(root: string): Lock | null {
  try {
    const lock = JSON.parse(readFileSync(join(root, ".lock"), "utf8")) as Lock | null;
    return typeof lock?.pid === "number" && typeof lock.at === "number" ? lock : null;
  } catch {
    return null;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether a watcher is alive in this root: it checked lately, or it is in the middle of a build. */
export function healthy(root: string, interval: number, timeout = DEFAULT_TIMEOUT_MS): boolean {
  const lock = readLock(root);
  if (lock && Date.now() - lock.at < timeout + 60_000) return true;
  const checked = Date.parse(readStatus(root)?.checkedAt ?? "");
  return Date.now() - checked < interval * 3 + 30_000;
}

/** A symlink in a release that points out of it, which a web server would follow. */
function linkOut(folder: string, root = folder): string | null {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(path);
      const to = resolve(dirname(path), target);
      if (isAbsolute(target) || (to !== root && !to.startsWith(root + sep)))
        return relative(root, path);
    } else if (entry.isDirectory()) {
      const found = linkOut(path, root);
      if (found) return found;
    }
  }
  return null;
}

export class Deployer {
  private busy: Promise<Outcome> | null = null;
  private building: ChildProcess | undefined;
  private aborted = false;
  private locked = false;

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

  /** Stops a build in progress, with everything it started, and records nothing about it. */
  abort(): void {
    this.aborted = true;
    this.killBuild();
    this.unlock();
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
    let sha: string;
    try {
      const info = lstatSync(file);
      // A commit id and a newline: anything else there is not a request, and is never read.
      sha = info.isFile() && info.size <= 64 ? readFileSync(file, "utf8").trim() : "";
    } catch {
      return;
    }
    rmSync(file, { recursive: true, force: true });
    if (!(await this.rollback(sha)))
      this.options.log(`rollback to ${JSON.stringify(sha.slice(0, 7))} refused: no such release`);
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

    // Two builders in one root would build in the same work folder.
    if (!this.lock()) {
      log(`${sha.slice(0, 7)} left to the builder already at work in ${root}`);
      return { outcome: "busy", sha };
    }
    const work = join(root, "work");
    rmSync(work, { recursive: true, force: true });
    const message = await this.subject(sha);
    log(`${sha.slice(0, 7)} ${message}: building`);
    try {
      const timeout = this.options.timeout ?? DEFAULT_TIMEOUT_MS;
      await run("git", [...SAFE_GIT, "clone", "-q", "--no-checkout", source, work], {
        timeout,
        env: GIT_ENV,
      });
      await run(
        "git",
        [...SAFE_GIT, "-C", work, "checkout", "-q", "--detach", "--end-of-options", sha],
        { timeout, env: GIT_ENV },
      );
      await this.build(work);
      const release = join(root, "releases", sha);
      const output = resolve(work, this.options.output);
      // The output must be a folder the build made inside the checkout, not a way out of it.
      if (!output.startsWith(work + sep) || !lstatSync(output).isDirectory()) {
        throw new BuildError(
          `DEPLOY_OUTPUT ${this.options.output} is not a folder inside the checkout.`,
        );
      }
      const stray = linkOut(output);
      if (stray) {
        throw new BuildError(
          `The build left a link at ${stray} that points outside its output, so it was not put live.`,
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
      // Stopping the builder in the middle of a build says nothing about the commit.
      if (!this.aborted) {
        status.failed = { sha, message, at: new Date().toISOString(), log: detail.slice(-8000) };
      }
      log(
        `${sha.slice(0, 7)} ${this.aborted ? "stopped" : "failed"}; ${status.live ? `${status.live.sha.slice(0, 7)} stays live` : "nothing is live"}`,
      );
      return { outcome: "failed", sha, log: detail };
    } finally {
      rmSync(work, { recursive: true, force: true });
      this.writeStatus(status);
      this.unlock();
    }
  }

  private async tip(): Promise<string> {
    const { stdout } = await run(
      "git",
      [...SAFE_GIT, "ls-remote", this.options.source, `refs/heads/${this.options.branch}`],
      { timeout: GIT_QUICK_MS, env: GIT_ENV },
    );
    const sha = stdout.split(/\s/)[0];
    if (!sha) throw new Error(`${this.options.source} has no branch "${this.options.branch}".`);
    return sha;
  }

  private async subject(sha: string): Promise<string> {
    try {
      const { stdout } = await run(
        "git",
        [
          ...SAFE_GIT,
          "-C",
          this.options.source,
          "log",
          "-1",
          "--format=%s",
          "--end-of-options",
          sha,
        ],
        { timeout: GIT_QUICK_MS, env: GIT_ENV },
      );
      return stdout.trim();
    } catch {
      return "";
    }
  }

  /** Runs the build command with its output captured, killed if it outlives the timeout. */
  private build(cwd: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      if (this.aborted) return reject(new BuildError("The builder was stopped."));
      // Its own process group, so a timeout ends the installs and compilers the shell started too.
      const child = spawn("sh", ["-c", this.options.build], {
        cwd,
        env: { ...process.env, CI: "1" },
        detached: true,
      });
      this.building = child;
      let output = "";
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-64_000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => this.killBuild(), this.options.timeout ?? DEFAULT_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        this.building = undefined;
        reject(new BuildError(`${error.message}\n${output}`));
      });
      // Anything the build left running would hold its output open, and the next build's folder.
      child.on("exit", () => this.killBuild());
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.building = undefined;
        if (code === 0) resolvePromise(output);
        else reject(new BuildError(`${output}\nbuild exited with ${signal ?? `code ${code}`}`));
      });
    });
  }

  private killBuild(): void {
    const pid = this.building?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group has already gone.
    }
  }

  /** Takes the root for one build; a lock left by a builder that died is taken over. */
  private lock(): boolean {
    const file = join(this.options.root, ".lock");
    const mine: Lock = { pid: process.pid, host: hostname(), at: Date.now() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
        this.locked = true;
        return true;
      } catch {
        const held = readLock(this.options.root);
        const here = held?.host === mine.host;
        const dead = !held || (here && (held.pid === mine.pid || !running(held.pid)));
        const old =
          !held || Date.now() - held.at > (this.options.timeout ?? DEFAULT_TIMEOUT_MS) + 60_000;
        if (!dead && !old) return false;
        rmSync(file, { force: true });
      }
    }
    return false;
  }

  private unlock(): void {
    if (!this.locked) return;
    this.locked = false;
    rmSync(join(this.options.root, ".lock"), { force: true });
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
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`);
    renameSync(temp, file);
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

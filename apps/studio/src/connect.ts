/**
 * Getting a site in front of the studio without a terminal: the folders under the sites folder,
 * copying a repository into it, and the preview address a new site gets. Cloning only fetches
 * files; nothing from the repository runs here, hooks included.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Site } from "./db.js";
import { withGitConfig } from "./repo.js";

/** A folder path as typed: `~` is this machine's home, and anything else must be absolute. */
export function folderPath(input: string): { path: string } | { error: string } {
  const typed = input.trim();
  const expanded =
    typed === "~" ? homedir() : typed.startsWith("~/") ? join(homedir(), typed.slice(2)) : typed;
  if (!isAbsolute(expanded)) {
    return { error: "Give the full path, starting with / (or ~ for your home folder)." };
  }
  return { path: resolve(expanded) };
}

export type FolderState = "connected" | "ready" | "needs-setup";

export interface Folder {
  name: string;
  path: string;
  state: FolderState;
  /** The site already using this folder, when there is one. */
  siteId?: string;
}

/** Where a folder's `origin` remote points, or null; reading config runs nothing of the repository's. */
export function originOf(path: string): Promise<string | null> {
  return new Promise((resolvePromise) =>
    execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-C", path, "remote", "get-url", "origin"],
      { timeout: 5000 },
      (error, stdout) => resolvePromise(error ? null : stdout.trim() || null),
    ),
  );
}

/** One spelling for a repository's address, https or SSH, with or without `.git`. */
export function sameRepository(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/, "https://$1/")
    .replace(/^https?:\/\/[^@/]+@/, "https://")
    .replace(/^http:/, "https:")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/**
 * Asks the preview service to start a site's dev server, and does not wait: by the time someone
 * opens the editor, the preview is usually up instead of showing its starting page.
 */
export function warmPreview(probe: string, devUrl: string): void {
  try {
    const target = new URL(probe);
    const request = httpRequest({
      host: target.hostname,
      port: target.port || 80,
      path: "/__greatcms/warm",
      method: "GET",
      headers: { host: new URL(devUrl).host },
      timeout: 2000,
    });
    request.on("response", (response) => response.resume());
    request.on("timeout", () => request.destroy());
    request.on("error", () => undefined);
    request.end();
  } catch {
    // A preview that cannot be warmed starts when it is first looked at, as before.
  }
}

/** Never sites, and slow to look into. */
const SKIP = new Set(["node_modules", "lost+found"]);

/** The folders directly under the sites folder, sites already connected first, then by name. */
export function listFolders(root: string, sites: Site[]): Folder[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const byPath = new Map(sites.map((site) => [resolve(site.path), site]));
  const order: Record<FolderState, number> = { ready: 0, "needs-setup": 1, connected: 2 };
  return entries
    .map((name): Folder => {
      const path = join(root, name);
      const site = byPath.get(path);
      if (site) return { name, path, state: "connected", siteId: site.id };
      return { name, path, state: hasSchema(path) ? "ready" : "needs-setup" };
    })
    .toSorted((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
}

/** The same names the studio reads a schema from. */
export function hasSchema(path: string): boolean {
  return [".cms/schema.yaml", ".cms/schema.yml", ".cms/schema.json"].some((name) => {
    try {
      return statSync(join(path, name)).isFile();
    } catch {
      return false;
    }
  });
}

/** Whether `path` is the sites folder itself or lies inside it. */
export function isInside(root: string, path: string): boolean {
  const base = resolve(root);
  const target = resolve(path);
  return target === base || target.startsWith(`${base}/`);
}

/** A readable name from a folder name: `nesa-petroleum` becomes `Nesa petroleum`. */
export function nameFromFolder(folder: string): string {
  const words = folder.replace(/[-_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : folder;
}

/**
 * Addresses git may clone from: https, ssh and scp-like `git@host:path`. Not `file:` or a local
 * path, which would copy any repository on this machine, and not `ext::`, which runs a command.
 */
export function isCloneUrl(value: string): boolean {
  return cloneUrlProblem(value) === null;
}

const CLONE_URL_HELP = "Use an https:// or SSH address, such as git@github.com:you/site.git.";

/** Why an address cannot be cloned, or null when it can. */
export function cloneUrlProblem(value: string): string | null {
  if (value.startsWith("-") || /\s/.test(value) || value.length > 2000) return CLONE_URL_HELP;
  if (/^[\w.-]+@[\w.-]+:[^/\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return CLONE_URL_HELP;
  }
  if (!["https:", "http:", "ssh:"].includes(url.protocol) || !url.hostname) return CLONE_URL_HELP;
  // A token in the address is kept in the copy's config, shown on this page and in the process list.
  if (url.password || (url.protocol !== "ssh:" && url.username)) {
    return "Leave the user name and token out of the address: save a token for that host on Git access instead.";
  }
  return null;
}

/** The host an address reaches, for either spelling. */
export function cloneHost(value: string): string | null {
  const scp = /^[\w.-]+@([\w.-]+):[^/\\]/.exec(value);
  if (scp) return scp[1] as string;
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, "") || null;
  } catch {
    return null;
  }
}

/** Loopback, private, link-local and other addresses that only mean something inside this network. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? (mapped[1] as string) : address;
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(ip) !== 6) return true;
  const lower = ip.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    /^f[cd]/.test(lower) ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff") ||
    lower.startsWith("::ffff:") ||
    lower.startsWith("64:ff9b:")
  );
}

export type ResolveHost = (host: string) => Promise<string[]>;

const resolveWithDns: ResolveHost = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/**
 * Whether an address leads inside this machine or its network, such as a cloud metadata service:
 * a copy from there would read what only this server can reach. A name that does not resolve is
 * left for git to report.
 */
export async function reachesPrivateNetwork(
  value: string,
  resolveHost: ResolveHost = resolveWithDns,
): Promise<boolean> {
  const host = cloneHost(value);
  if (!host) return true;
  if (isIP(host)) return isPrivateAddress(host);
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) return true;
  const addresses = await resolveHost(host).catch(() => [] as string[]);
  return addresses.some(isPrivateAddress);
}

/** The folder a clone lands in by default: the repository's own name. */
export function folderFromUrl(url: string): string {
  const last =
    url
      .replace(/[/\\]+$/, "")
      .split(/[/:]/)
      .at(-1) ?? "";
  return last.replace(/\.git$/, "");
}

const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isFolderName(name: string): boolean {
  return FOLDER_NAME.test(name) && !name.endsWith(".lock");
}

/** A branch git would accept and that cannot be read as an option. */
export function isBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) && !name.includes("..") && !name.endsWith("/")
  );
}

export type CloneState =
  | { state: "cloning"; folder: string; url: string }
  | { state: "done"; folder: string; url: string; path: string }
  | { state: "failed"; folder: string; url: string; reason: string };

export type CloneGit = (
  args: string[],
  config: Array<[string, string]>,
  signal?: AbortSignal,
) => Promise<void>;

export interface CloneLimits {
  /** Copies running at once; another is refused until one finishes. */
  concurrent: number;
  /** The most a copy may take on disk before it is stopped. */
  maxBytes: number;
  /** How often a running copy is measured. */
  measureEveryMs: number;
}

export const CLONE_LIMITS: CloneLimits = {
  concurrent: 2,
  maxBytes: 2 * 1024 * 1024 * 1024,
  measureEveryMs: 2000,
};
/** Finished copies remembered for the page; the oldest is forgotten past this. */
const MAX_FINISHED = 20;

/** Removes copies a stopped studio left half-made, so the same name can be copied again. */
export function sweepStaleClones(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => /^\..+\.cloning$/.test(name));
  } catch {
    return [];
  }
  for (const name of names) rmSync(join(root, name), { recursive: true, force: true });
  return names;
}

/** Bytes under a folder, stopping early once past `limit`; links are counted, not followed. */
async function sizeOf(folder: string, limit: number): Promise<number> {
  let total = 0;
  const pending = [folder];
  while (pending.length > 0 && total <= limit) {
    const current = pending.pop() as string;
    // oxlint-disable-next-line no-await-in-loop -- one folder at a time, so a huge copy cannot flood the disk queue
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    // oxlint-disable-next-line no-await-in-loop -- as above
    const sizes = await Promise.all(
      entries.map((entry) => {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
          return 0;
        }
        return lstat(path).then(
          (stat) => stat.size,
          () => 0,
        );
      }),
    );
    for (const size of sizes) total += size;
  }
  return total;
}

/**
 * Clones run in the background, because a large repository takes longer than a proxy waits for
 * an answer. The connect page shows each one until it finishes or fails.
 */
export class Clones {
  private readonly jobs = new Map<string, CloneState>();
  private readonly running = new Set<AbortController>();
  private readonly limits: CloneLimits;

  constructor(
    private readonly root: string,
    private readonly git: CloneGit = runGit,
    limits: Partial<CloneLimits> = {},
  ) {
    this.limits = { ...CLONE_LIMITS, ...limits };
  }

  list(): CloneState[] {
    return [...this.jobs.values()];
  }

  /** Stops every copy in flight, as the studio stops: a git left running would outlive it. */
  stop(): void {
    for (const controller of this.running) controller.abort();
  }

  /** Forgets a finished clone, once someone has seen how it went. */
  dismiss(folder: string): void {
    if (this.jobs.get(folder)?.state !== "cloning") this.jobs.delete(folder);
  }

  /** Why a copy into `folder` cannot start now, or null when it can. */
  busy(folder: string): string | null {
    if (this.jobs.get(folder)?.state === "cloning") return `${folder} is already being copied.`;
    const running = this.list().filter((job) => job.state === "cloning").length;
    return running >= this.limits.concurrent
      ? "Other copies are still running: wait for one to finish, then try again."
      : null;
  }

  /** Starts a clone; the promise is for tests, the page does not wait for it. */
  /** `config` signs this one clone in, such as a GitHub App's token; it is not kept anywhere. */
  start(
    url: string,
    folder: string,
    branch: string,
    config: Array<[string, string]> = [],
  ): Promise<void> {
    const path = join(this.root, folder);
    const problem = this.busy(folder);
    if (problem) return Promise.reject(new Error(problem));
    this.jobs.delete(folder);
    this.jobs.set(folder, { state: "cloning", folder, url });
    // Cloned beside its final name and renamed when complete, so a half-copied folder is never listed.
    const temporary = join(this.root, `.${folder}.cloning`);
    rmSync(temporary, { recursive: true, force: true });
    const args = [
      // Nothing in the repository runs: no hooks, no fsmonitor, no transport that runs a command.
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.file.allow=never",
      // A redirect could lead inside this network, or carry a sign-in to another host.
      "-c",
      "http.followRedirects=false",
      "clone",
      "--quiet",
      "--no-recurse-submodules",
      ...(branch ? ["--branch", branch] : []),
      "--",
      url,
      temporary,
    ];
    const stop = new AbortController();
    this.running.add(stop);
    let tooLarge = false;
    const measure = setInterval(() => {
      void sizeOf(temporary, this.limits.maxBytes).then((bytes) => {
        if (bytes <= this.limits.maxBytes) return;
        tooLarge = true;
        stop.abort();
      });
    }, this.limits.measureEveryMs);
    measure.unref();
    return this.git(args, config, stop.signal)
      .then(() => {
        renameSync(temporary, path);
        this.jobs.set(folder, { state: "done", folder, url, path });
      })
      .catch((error: Error) => {
        // A failed clone leaves nothing behind for the next attempt to trip over.
        rmSync(temporary, { recursive: true, force: true });
        const reason = tooLarge
          ? `The repository is larger than ${Math.round(this.limits.maxBytes / 1024 / 1024)} MB, so the copy was stopped.`
          : cloneFailure(error);
        this.jobs.set(folder, { state: "failed", folder, url, reason });
      })
      .finally(() => {
        clearInterval(measure);
        this.running.delete(stop);
        const finished = this.list().filter((job) => job.state !== "cloning");
        for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
          this.jobs.delete(job.folder);
        }
      });
  }
}

/** git's last words, without the noise, and never a credential it echoed back. */
export function cloneFailure(error: Error & { stderr?: string }): string {
  const text = String(error.stderr || error.message || "")
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1")
    .split("\n")
    .map((line) => line.replace(/^(fatal|error|remote): /, "").trim())
    .filter(Boolean);
  if (
    text.some((line) =>
      /could not read Username|Authentication failed|terminal prompts disabled/i.test(line),
    )
  ) {
    // A host answers a repository that is not there exactly as it answers a private one.
    return "The host asked for a sign-in. Either there is no repository at that address, or it is private and this studio has no access to it.\n  fix: check the address for a typing mistake, or give the studio access under Git access, then try again.";
  }
  if (text.some((line) => /Remote branch .* not found/i.test(line))) {
    return "That branch does not exist in the repository.";
  }
  if (text.some((line) => /returned error: 30[1278]|redirect/i.test(line))) {
    return "That address sends git somewhere else, and redirects are not followed. Use the repository's current address.";
  }
  if (text.some((line) => /not found|does not exist|Could not resolve host/i.test(line))) {
    return "Nothing was found at that address. Check it, and that this machine can reach it.";
  }
  return text.at(-1) ?? "git could not clone the repository.";
}

function runGit(
  args: string[],
  config: Array<[string, string]>,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      {
        timeout: 10 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        // A missing credential fails at once instead of waiting for someone to type a password.
        env: withGitConfig(
          { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
          config,
        ),
      },
      (error, _stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }));
        else resolvePromise();
      },
    );
  });
}

/**
 * Where browsers see a site's preview, from `STUDIO_PREVIEW_URL`: a template such as
 * `https://{site}-preview.example.com` where `{site}` becomes a short name for the site.
 */
export class PreviewAddresses {
  private readonly pattern: RegExp;

  constructor(readonly template: string) {
    if (!template.includes("{site}")) {
      throw new Error(
        "STUDIO_PREVIEW_URL needs {site} where each site's name goes.\n  fix: STUDIO_PREVIEW_URL=https://{site}-preview.example.com",
      );
    }
    let host: string;
    try {
      const url = new URL(template.replace("{site}", "site"));
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      host = url.hostname;
    } catch {
      throw new Error("STUDIO_PREVIEW_URL must be an http:// or https:// address.");
    }
    if (!host.includes("site")) {
      throw new Error(
        "STUDIO_PREVIEW_URL must put {site} in the host name, so each site has its own.",
      );
    }
    const [before, after] = template.replace(/\/+$/, "").split("{site}") as [string, string];
    this.pattern = new RegExp(`^${escape(before)}([a-z0-9][a-z0-9-]*)${escape(after)}/?$`);
  }

  /** The preview address for a short name. */
  url(name: string): string {
    return this.template.replace("{site}", name).replace(/\/+$/, "");
  }

  /** The short name in a dev URL, when the URL is one of these addresses. */
  nameOf(devUrl: string): string | null {
    return this.pattern.exec(devUrl)?.[1] ?? null;
  }

  /** A free address for a new site, from its folder name: `nesa`, then `nesa-2`. */
  suggest(folder: string, sites: Site[]): string {
    const base =
      folder
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "") || "site";
    const taken = new Set(sites.map((site) => this.nameOf(site.devUrl)).filter(Boolean));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    return this.url(name);
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PreviewEntry {
  id: string;
  name: string;
  /** The host browsers ask for, which the preview service routes by. */
  host: string;
  path: string;
}

/** Every site whose dev URL is one of the preview addresses, for the preview service. */
export function previewEntries(sites: Site[], addresses: PreviewAddresses): PreviewEntry[] {
  return sites.flatMap((site) =>
    addresses.nameOf(site.devUrl)
      ? [{ id: site.id, name: site.name, host: new URL(site.devUrl).host, path: site.path }]
      : [],
  );
}

/**
 * Writes the list the preview service reads, whole or not at all: it is replaced by a rename, so
 * the service never reads half of it.
 */
export function writePreviewList(file: string, entries: PreviewEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  // A name nobody can guess, created new: a link planted at a known name would be written through.
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sites: entries }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

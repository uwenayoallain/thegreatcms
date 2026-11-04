/**
 * What the builder (`greatcms-deploy`) says about a site: what is live, what failed, and which
 * releases a rollback can return to. Read from its folder, never asked of it, and a rollback is
 * a request file it picks up on its next check: the studio still runs nothing of the site's.
 */

import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

interface Release {
  sha: string;
  message: string;
  at: string;
}

export interface LiveSite {
  live?: Release;
  failed?: Release & { log: string };
  pinned?: { sha: string; at: string };
  checkedAt?: string;
  /** Kept on disk, newest first. */
  releases: Array<{ sha: string; at: string }>;
  /** A rollback asked for and not yet picked up. */
  requested?: string;
}

const SHA = /^[0-9a-f]{40}$/;
/** The builder writes a few kilobytes; anything far larger is not its status file. */
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_LOG = 8000;

/**
 * The builder's folder is another process's, so what is in it is read as untrusted: no file is
 * followed out through a link, nothing oversized is read, and only the fields and shapes the
 * studio shows are kept.
 */
export async function readLive(root: string): Promise<LiveSite | null> {
  if (!root) return null;
  const raw = await readInside(root, "status.json", MAX_STATUS_BYTES);
  if (raw === null) return null;
  let status: unknown;
  try {
    status = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(status)) return null;

  const dir = join(root, "releases");
  const names =
    existsSync(dir) && (await isInside(root, dir))
      ? await readdir(dir, { withFileTypes: true })
      : [];
  const releases = await Promise.all(
    names
      .filter((entry) => entry.isDirectory() && SHA.test(entry.name))
      .map(async (entry) => ({
        sha: entry.name,
        at: (await stat(join(dir, entry.name))).mtime.toISOString(),
      })),
  );
  const requested = (await readInside(root, "rollback", 128))?.trim();
  const failed = release(status.failed);
  return {
    live: release(status.live),
    failed: failed
      ? {
          ...failed,
          log: typeof status.failed === "object" ? text(status.failed, "log", MAX_LOG) : "",
        }
      : undefined,
    pinned: pinnedOf(status.pinned),
    checkedAt: typeof status.checkedAt === "string" ? status.checkedAt.slice(0, 40) : undefined,
    releases: releases.toSorted((a, b) => b.at.localeCompare(a.at)),
    requested: requested && SHA.test(requested) ? requested : undefined,
  };
}

/** Asks the builder to put `sha` back live; false when there is no such release to go back to. */
export async function requestRollback(root: string, sha: string): Promise<boolean> {
  if (!root || !SHA.test(sha) || !existsSync(join(root, "releases", sha))) return false;
  if (!(await isInside(root, join(root, "releases", sha)))) return false;
  await writeFile(join(root, "rollback"), `${sha}\n`);
  return true;
}

/** A regular file directly in `root`, never a link, at most `limit` bytes; null otherwise. */
async function readInside(root: string, name: string, limit: number): Promise<string | null> {
  const path = join(root, name);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > limit) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function isInside(root: string, path: string): Promise<boolean> {
  try {
    const [base, real] = await Promise.all([realpath(root), realpath(path)]);
    const inside = relative(base, real);
    return !(inside.startsWith("..") || resolve(inside) === inside);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, key: string, limit = 500): string {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" ? field.slice(0, limit) : "";
}

/** A release the studio can name: a real commit id, with its message and time as plain text. */
function release(value: unknown): Release | undefined {
  if (!isRecord(value) || typeof value.sha !== "string" || !SHA.test(value.sha)) return undefined;
  return { sha: value.sha, message: text(value, "message"), at: text(value, "at", 40) };
}

function pinnedOf(value: unknown): LiveSite["pinned"] {
  if (!isRecord(value) || typeof value.sha !== "string" || !SHA.test(value.sha)) return undefined;
  return { sha: value.sha, at: text(value, "at", 40) };
}

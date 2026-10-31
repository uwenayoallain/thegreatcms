/**
 * What the builder (`greatcms-deploy`) says about a site: what is live, what failed, and which
 * releases a rollback can return to. Read from its folder, never asked of it, and a rollback is
 * a request file it picks up on its next check: the studio still runs nothing of the site's.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function readLive(root: string): Promise<LiveSite | null> {
  if (!root) return null;
  let status: Omit<LiveSite, "releases">;
  try {
    status = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
  } catch {
    return null;
  }
  const dir = join(root, "releases");
  const names = existsSync(dir) ? await readdir(dir, { withFileTypes: true }) : [];
  const releases = await Promise.all(
    names
      .filter((entry) => entry.isDirectory() && SHA.test(entry.name))
      .map(async (entry) => ({
        sha: entry.name,
        at: (await stat(join(dir, entry.name))).mtime.toISOString(),
      })),
  );
  let requested: string | undefined;
  try {
    requested = (await readFile(join(root, "rollback"), "utf8")).trim();
  } catch {
    requested = undefined;
  }
  return {
    ...status,
    releases: releases.toSorted((a, b) => b.at.localeCompare(a.at)),
    requested,
  };
}

/** Asks the builder to put `sha` back live; false when there is no such release to go back to. */
export async function requestRollback(root: string, sha: string): Promise<boolean> {
  if (!root || !SHA.test(sha) || !existsSync(join(root, "releases", sha))) return false;
  await writeFile(join(root, "rollback"), `${sha}\n`);
  return true;
}

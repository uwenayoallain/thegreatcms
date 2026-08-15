/** Local draft preview. */

import type { CmsConfig } from "@greatcms/spec";

export interface GitPort {
  /** Runs a git command, returning stdout. Throws on non-zero exit. */
  run(args: string[]): Promise<string>;
}

export interface FilePort {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface PreviewOptions {
  config: CmsConfig;
  /** Draft branch to preview. Defaults to every branch under the draft prefix. */
  branch?: string;
  remote?: string;
  force?: boolean;
}

export interface OverlayFile {
  path: string;
  /** What the working copy held before, so it can be put back exactly. */
  previous: string | null;
  next: string;
}

export interface PreviewPlan {
  branches: string[];
  files: OverlayFile[];
}

export class PreviewError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(fix ? `${message}\n  fix: ${fix}` : message);
    this.name = "PreviewError";
  }
}

/** Draft branches that exist on the remote, newest listing order preserved. */
export async function findDraftBranches(
  git: GitPort,
  config: CmsConfig,
  remote = "origin",
): Promise<string[]> {
  const prefix = config.publish.draftBranchPrefix;
  const output = await git.run(["ls-remote", "--heads", remote, `refs/heads/${prefix}*`]);
  return output
    .split("\n")
    .map((line) => line.split("\t")[1] ?? "")
    .filter(Boolean)
    .map((ref) => ref.replace("refs/heads/", ""))
    .toSorted();
}

/** Works out which files the overlay would touch, without writing anything. */
export async function planPreview(
  git: GitPort,
  files: FilePort,
  options: PreviewOptions,
): Promise<PreviewPlan> {
  const { config, remote = "origin" } = options;

  const branches = options.branch ? [options.branch] : await findDraftBranches(git, config, remote);

  if (branches.length === 0) {
    throw new PreviewError(
      "No draft branches found.",
      `Save a draft in the studio first — it pushes to ${config.publish.draftBranchPrefix}-<region>.`,
    );
  }

  const allowed = [config.content.regions, config.content.media].map(trimSlashes);
  const planned = new Map<string, OverlayFile>();

  // Fetches stay sequential because git takes a repository-wide lock; running them at once would.
  for (const branch of branches) {
    // oxlint-disable-next-line no-await-in-loop -- git repo lock, see above
    await git.run(["fetch", remote, `${branch}:refs/greatcms/${branch}`, "--force"]);

    const changed = // oxlint-disable-next-line no-await-in-loop -- depends on the fetch above
      (await git.run(["diff", "--name-only", `${config.publish.branch}...refs/greatcms/${branch}`]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    for (const path of changed) {
      if (!allowed.some((dir) => path === dir || path.startsWith(`${dir}/`))) {
        throw new PreviewError(
          `Draft branch "${branch}" changes ${path}, which is outside the content directories.`,
          "A draft may only carry content. Inspect that branch before trusting it.",
        );
      }
    }

    // Reading the files themselves is independent work, so it goes at once.
    // oxlint-disable-next-line no-await-in-loop -- already batched per branch
    const contents = await Promise.all(
      changed.map(async (path) => ({
        path,
        next: await git.run(["show", `refs/greatcms/${branch}:${path}`]),
        previous: await files.read(path),
      })),
    );
    for (const file of contents) planned.set(file.path, file);
  }

  return { branches, files: [...planned.values()] };
}

/** Applies the overlay and hands back a restore function. */
export async function applyOverlay(
  files: FilePort,
  plan: PreviewPlan,
): Promise<() => Promise<void>> {
  const applied: OverlayFile[] = [];

  // Sequential on purpose, in both directions: `applied` must record exactly what reached the disk.
  for (const file of plan.files) {
    // oxlint-disable-next-line no-await-in-loop -- ordered writes, see above
    await files.write(file.path, file.next);
    applied.push(file);
  }

  return async () => {
    for (const file of applied.toReversed()) {
      if (file.previous === null) {
        // oxlint-disable-next-line no-await-in-loop -- ordered restore
        await files.remove(file.path);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- ordered restore
        await files.write(file.path, file.previous);
      }
    }
  };
}

/** Refuses to overlay on top of uncommitted content changes, which would be unrecoverable once. */
export async function assertContentIsClean(
  git: GitPort,
  config: CmsConfig,
  force = false,
): Promise<void> {
  if (force) return;

  const dirty = (
    await git.run([
      "status",
      "--porcelain",
      "--",
      trimSlashes(config.content.regions),
      trimSlashes(config.content.media),
    ])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (dirty.length > 0) {
    throw new PreviewError(
      `You have uncommitted changes in your content directories:\n    ${dirty.join("\n    ")}`,
      "Commit or stash them first, or pass --force to overlay on top of them anyway.",
    );
  }
}

export function describePlan(plan: PreviewPlan): string {
  const lines = [
    `Previewing ${plan.branches.length} draft branch${plan.branches.length === 1 ? "" : "es"}:`,
    ...plan.branches.map((branch) => `  ${branch}`),
    "",
    `${plan.files.length} content file${plan.files.length === 1 ? "" : "s"}:`,
    ...plan.files.map((file) => `  ${file.previous === null ? "new  " : "edit "} ${file.path}`),
  ];
  return lines.join("\n");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

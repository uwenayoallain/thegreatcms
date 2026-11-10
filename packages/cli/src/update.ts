/** Says when a newer greatcms is on npm: asked at most once a day, and never in a command's way. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DAY_MS = 24 * 60 * 60_000;
const VERSION = /^\d+\.\d+\.\d+$/;
const LATEST = "https://registry.npmjs.org/@greatcms/cli/latest";

export interface UpdateCheck {
  current: string;
  cwd: string;
  /** Whether a person is reading: a script or CI is never told. */
  interactive: boolean;
  env?: Record<string, string | undefined>;
  now?: number;
  cacheFile?: string;
  fetcher?: typeof fetch;
}

/** Whether `latest` is a later release than `current`; anything that is not x.y.z is not. */
export function isNewer(latest: string, current: string): boolean {
  if (!VERSION.test(latest) || !VERSION.test(current)) return false;
  const [a, b] = [latest, current].map((version) => version.split(".").map(Number));
  for (let part = 0; part < 3; part++) {
    if (a![part] !== b![part]) return a![part]! > b![part]!;
  }
  return false;
}

/** The command that updates this project, in the package manager its lockfile names. */
export function updateCommand(cwd: string): string {
  const packages = "@greatcms/cli@latest @greatcms/reader@latest";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return `pnpm add -D ${packages}`;
  if (existsSync(join(cwd, "yarn.lock"))) return `yarn add -D ${packages}`;
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) {
    return `bun add -d ${packages}`;
  }
  return `npm install -D ${packages}`;
}

function defaultCache(env: Record<string, string | undefined>): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "greatcms", "update.json");
}

/**
 * The notice to print, or null: when this is the latest, when nobody is reading, when it was
 * switched off, or when npm did not answer in time. It never throws and never waits long.
 */
export async function updateNotice(check: UpdateCheck): Promise<string | null> {
  const env = check.env ?? process.env;
  if (!check.interactive || env.CI || env.GREATCMS_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER) {
    return null;
  }
  const now = check.now ?? Date.now();
  const file = check.cacheFile ?? defaultCache(env);
  let latest: string | undefined;
  try {
    const kept = JSON.parse(readFileSync(file, "utf8")) as { at?: number; latest?: string };
    if (typeof kept.at === "number" && now - kept.at < DAY_MS && now >= kept.at) {
      latest = typeof kept.latest === "string" ? kept.latest : "";
    }
  } catch {
    // Never asked, or a file that does not read: ask now.
  }
  if (latest === undefined) {
    latest = "";
    try {
      const response = await (check.fetcher ?? fetch)(LATEST, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(1500),
      });
      const version = ((await response.json()) as { version?: unknown }).version;
      if (response.ok && typeof version === "string" && VERSION.test(version)) latest = version;
    } catch {
      // Offline, slow or refused: said nothing about, and not asked again today.
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ at: now, latest }));
    } catch {
      // A cache that cannot be written only means npm is asked again next time.
    }
  }
  if (!isNewer(latest, check.current)) return null;
  return `\ngreatcms ${latest} is available: this is ${check.current}.\n  update: ${updateCommand(check.cwd)}\n`;
}

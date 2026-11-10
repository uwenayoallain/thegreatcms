/** Sites declared in `STUDIO_SITES`, so a server starts already managing them under ids that do not change. */

import { isAbsolute } from "node:path";
import type { Store } from "./db.js";

export interface DeclaredSite {
  id: string;
  path: string;
  name: string;
  devUrl: string;
  /** Where this server reaches the dev server, when browsers reach it somewhere else. */
  probeUrl: string;
  pushAfterPublish: boolean;
  /** The builder's DEPLOY_ROOT as this studio sees it, e.g. /srv/www. */
  deployRoot: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** What the studio is started with that nothing it starts, git included, has any use for. */
const SECRETS = ["STUDIO_PASSWORD", "STUDIO_SECRET", "RESEND_API_KEY", "STUDIO_WEBHOOK_URL"];

/** Takes the studio's own secrets out of the environment its child processes inherit. */
export function withoutSecrets(env: NodeJS.ProcessEnv): void {
  for (const name of SECRETS) delete env[name];
}

export function parseSites(source: string): DeclaredSite[] {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error(
      'STUDIO_SITES is not JSON.\n  fix: STUDIO_SITES=\'[{"id":"my-site","path":"/srv/sites/my-site"}]\'',
    );
  }
  if (!Array.isArray(raw)) throw new Error("STUDIO_SITES must be a JSON array of sites.");

  const seen = new Set<string>();
  return raw.map((entry: Record<string, unknown>) => {
    const id = String(entry?.id ?? "");
    const path = String(entry?.path ?? "");
    const devUrl = String(entry?.devUrl ?? "");
    const probeUrl = String(entry?.probeUrl ?? "");
    const deployRoot = String(entry?.deployRoot ?? "");
    if (!ID.test(id)) {
      throw new Error(
        `STUDIO_SITES: id "${id}" must be lowercase letters, digits and dashes; it becomes the form address.`,
      );
    }
    if (seen.has(id)) throw new Error(`STUDIO_SITES: "${id}" is listed twice.`);
    seen.add(id);
    if (!isAbsolute(path)) throw new Error(`STUDIO_SITES: "${id}" needs an absolute path.`);
    if (deployRoot && !isAbsolute(deployRoot)) {
      throw new Error(`STUDIO_SITES: "${id}" needs an absolute deployRoot.`);
    }
    if (devUrl && !/^https?:\/\/[^\s]+$/.test(devUrl)) {
      throw new Error(`STUDIO_SITES: "${id}" has a devUrl that is not an http(s) address.`);
    }
    if (probeUrl && !/^https?:\/\/[^\s]+$/.test(probeUrl)) {
      throw new Error(`STUDIO_SITES: "${id}" has a probeUrl that is not an http(s) address.`);
    }
    return {
      id,
      path,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
      devUrl,
      probeUrl,
      pushAfterPublish: entry.pushAfterPublish === true,
      deployRoot,
    };
  });
}

/** Adds sites that are missing and brings the rest in line with the environment. */
export function applySites(store: Store, sites: DeclaredSite[]): string[] {
  return sites.map((site) => {
    const existing = store.getSite(site.id);
    if (!existing) {
      store.addSite(site);
      return `${site.id}: added`;
    }
    if (existing.path !== site.path) {
      throw new Error(
        `STUDIO_SITES: "${site.id}" already points at ${existing.path}, not ${site.path}.\n  fix: use a new id for a different folder.`,
      );
    }
    store.updateSite(site.id, site);
    return `${site.id}: updated`;
  });
}

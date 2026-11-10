/** The studio as a function: what `greatcms studio` and anything else in-process calls to run one. */

import { serve } from "@hono/node-server";
import { dirname, join } from "node:path";
import { type AppOptions, createApp } from "./app.js";
import { randomSecret, sessionKey } from "./auth.js";
import { applySites, type DeclaredSite } from "./config.js";
import { Store } from "./db.js";
import { GitAccess } from "./git-access.js";
import { trustFolderGitConfig } from "./git-guard.js";
import { GitHub } from "./github.js";
import { isLoopback, localGuard, localPassword, localSecret, loopbackAddress } from "./local.js";

export { isLoopback } from "./local.js";

/** The oldest Node with `node:sqlite` as the studio uses it. */
export const MIN_NODE = "22.13.0";

type Passthrough = Omit<AppOptions, "store" | "password" | "secret" | "gitAccess" | "github">;

export interface StartOptions extends Passthrough {
  password: string;
  /** Signs sessions; a generated one means a restart signs everyone out. */
  secret?: string;
  databaseFile: string;
  port: number;
  /** The address to listen on; every interface when unset, as a server behind a proxy wants. */
  hostname?: string;
  sites?: DeclaredSite[];
  /** Wraps the app's handler, for local mode's checks. */
  wrap?: (
    handler: (request: Request, ...rest: unknown[]) => Response | Promise<Response>,
  ) => (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
}

export interface RunningStudio {
  port: number;
  /** What `applySites` did with each declared site. */
  declared: string[];
  close(): Promise<void>;
}

/** Opens the database, connects the declared sites and listens. Rejects when the port is taken. */
export async function start(options: StartOptions): Promise<RunningStudio> {
  const { password, databaseFile, port, hostname, sites = [], wrap, secret, ...rest } = options;
  const store = new Store(databaseFile);
  let declared: string[];
  let app: ReturnType<typeof createApp>;
  try {
    declared = applySites(store, sites);
    app = createApp({
      ...rest,
      store,
      password,
      secret: secret ?? randomSecret(),
      probeUrls:
        rest.probeUrls ??
        new Map(sites.filter((site) => site.probeUrl).map((site) => [site.id, site.probeUrl])),
      gitAccess: new GitAccess(join(dirname(databaseFile), "git")),
      github: new GitHub(join(dirname(databaseFile), "git", "github-app.json")),
    });
  } catch (error) {
    store.close();
    throw error;
  }

  // Publishes scheduled for later go out within half a minute of their time.
  const schedules = setInterval(() => void app.runDueSchedules(), 30_000);
  schedules.unref();

  const fetch = wrap ? wrap(app.fetch as never) : app.fetch;
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: fetch as typeof app.fetch, port, hostname }, (info) => {
      resolve({
        port: info.port,
        declared,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(schedules);
            server.close(() => {
              store.close();
              done();
            });
            // Keep-alive connections from the browser would otherwise hold the close open.
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
    server.once("error", (error) => {
      clearInterval(schedules);
      store.close();
      reject(error);
    });
  });
}

export interface LocalOptions {
  /** The site's folder: the one holding `.cms/schema.yaml`. */
  root: string;
  name: string;
  /** Where the database and the signing secret go; outside anything Git tracks. */
  stateDir: string;
  port: number;
  /** `127.0.0.1` unless told otherwise. Anything that is not loopback needs `password`. */
  host?: string;
  /** Where the site's dev server answers, for the live preview. */
  devUrl?: string;
  /** Required to listen anywhere but loopback, and then it is what signs people in. */
  password?: string;
}

export interface RunningLocalStudio extends RunningStudio {
  /** The address to open in a browser. */
  url: string;
  siteId: string;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "site";

/** One folder, one person, nothing to sign in to: what `greatcms studio` runs. */
export async function startLocal(options: LocalOptions): Promise<RunningLocalStudio> {
  const host = options.host ?? "127.0.0.1";
  const loopback = isLoopback(host);
  if (!loopback && !options.password) {
    throw new Error(
      `Refusing to listen on ${host} without a password: the local studio trusts whoever can reach it, which is only safe on this machine.\n  fix: drop --host, or set STUDIO_PASSWORD to a long random value.`,
    );
  }
  const { bind, urlHost } = loopback ? loopbackAddress(host) : { bind: host, urlHost: host };
  const secret = localSecret(options.stateDir);
  const password = loopback ? localPassword(secret) : (options.password as string);
  const databaseFile = join(options.stateDir, "studio.sqlite");
  const siteId = slug(options.name);

  // The cache can outlive a renamed or copied folder; the site is whichever folder this run is in.
  const store = new Store(databaseFile);
  let kept: { name: string; devUrl: string; pushAfterPublish: boolean } | undefined;
  try {
    for (const site of store.listSites()) {
      if (site.id === siteId && site.path === options.root) kept = site;
      else store.removeSite(site.id);
    }
  } finally {
    store.close();
  }

  // The folder is the developer's own checkout, and so is what its git config says.
  trustFolderGitConfig(true);
  const landing = `/sites/${siteId}`;
  const running = await start({
    password,
    secret,
    databaseFile,
    port: options.port,
    hostname: bind,
    local: true,
    sites: [
      {
        id: siteId,
        path: options.root,
        // What was changed in the site's settings on an earlier run stays changed.
        name: kept?.name ?? options.name,
        devUrl: options.devUrl ?? kept?.devUrl ?? "",
        probeUrl: "",
        pushAfterPublish: kept?.pushAfterPublish ?? false,
        deployRoot: "",
      },
    ],
    // Only on loopback is everyone who can ask the owner; anywhere else the password form decides.
    wrap: loopback
      ? (handler) =>
          localGuard(handler, {
            port: options.port,
            urlHost,
            signingKey: sessionKey(secret, password),
            landing,
          })
      : undefined,
  });
  return {
    ...running,
    siteId,
    url: `http://${urlHost}:${running.port}${landing}`,
  };
}

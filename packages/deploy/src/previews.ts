/**
 * `greatcms-preview` for many sites: one proxy, routed by the host a request names, with each
 * site's dev server started on first use and stopped when idle. The studio writes the list of
 * sites, so connecting a site in the studio is all it takes to preview it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  previewPage,
  type PreviewOptions,
  PreviewRunner,
  proxy,
  STATUS_PATH,
  upgrade,
} from "./preview.js";

/** Starts a site's dev server without waiting for it, so it is up by the time someone looks. */
export const WARM_PATH = "/__greatcms/warm";

export interface PreviewSite {
  id: string;
  name: string;
  /** The host browsers ask for, e.g. `shop-preview.example.com`. */
  host: string;
  /** The site's working copy. */
  path: string;
}

export interface PreviewSitesOptions {
  /** The JSON list the studio writes: `{ "version": 1, "sites": [...] }`. */
  sitesFile: string;
  port: number;
  /** The first port a dev server is given; each site takes the next free one. */
  firstUpstream: number;
  idle: number;
  startTimeout: number;
  log: (line: string) => void;
}

/** Where a framework's dev server binary takes its host and port. */
const FRAMEWORKS: Array<[dependency: string, command: string]> = [
  ["astro", 'astro dev --host 127.0.0.1 --port "$PORT" --ignore-lock'],
  ["next", 'next dev --hostname 127.0.0.1 --port "$PORT"'],
  ["nuxt", 'nuxt dev --host 127.0.0.1 --port "$PORT"'],
  ["@sveltejs/kit", 'vite dev --host 127.0.0.1 --port "$PORT" --strictPort'],
  ["vite", 'vite dev --host 127.0.0.1 --port "$PORT" --strictPort'],
];

/** The install a lockfile asks for; npm when there is none. */
const INSTALLS: Array<[lockfile: string, install: string, runner: string]> = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile", "pnpm"],
  ["yarn.lock", "yarn install --frozen-lockfile", "yarn"],
  ["package-lock.json", "npm ci", "npm"],
  ["bun.lock", "bun install --frozen-lockfile", "bun"],
  ["bun.lockb", "bun install --frozen-lockfile", "bun"],
];

/** The shell command that starts a site's dev server on $PORT, or why there is none. */
export function devCommand(path: string): { command: string } | { problem: string } {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  } catch {
    return { problem: "The site has no package.json, so there is no dev server to start." };
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const [, install, runner] = INSTALLS.find(([lockfile]) => existsSync(join(path, lockfile))) ?? [
    "",
    "npm install",
    "npm",
  ];
  const framework = FRAMEWORKS.find(([dependency]) => deps[dependency]);
  const start = framework
    ? `exec node_modules/.bin/${framework[1]}`
    : pkg.scripts?.dev
      ? `exec ${runner} run dev`
      : null;
  if (!start) {
    return {
      problem:
        'The site uses no framework this service knows (Astro, Next.js, Nuxt, SvelteKit, Vite) and has no "dev" script.',
    };
  }
  const installed = existsSync(join(path, "node_modules"));
  return { command: installed ? start : `${install} && ${start}` };
}

/** Reads the studio's list again whenever the file changes. */
export class SiteList {
  private sites: PreviewSite[] = [];
  private stamp = "";

  constructor(private readonly file: string) {}

  current(): PreviewSite[] {
    let stamp = "missing";
    try {
      const info = statSync(this.file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      this.sites = [];
    }
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { sites?: PreviewSite[] };
        this.sites = (parsed.sites ?? []).filter(
          (site) => typeof site.host === "string" && typeof site.path === "string",
        );
      } catch {
        // Missing or half-written: the last good list stands until the next change.
      }
    }
    return this.sites;
  }

  find(host: string): PreviewSite | undefined {
    const wanted = hostname(host);
    return this.current().find((site) => hostname(site.host) === wanted);
  }
}

function hostname(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "");
}

interface Running {
  site: PreviewSite;
  options: PreviewOptions;
  runner: PreviewRunner;
}

/** One runner per site, each on its own port, made when the site is first asked for. */
export class PreviewSites {
  readonly list: SiteList;
  private readonly running = new Map<string, Running>();
  private readonly ports = new Set<number>();

  constructor(private readonly options: PreviewSitesOptions) {
    this.list = new SiteList(options.sitesFile);
  }

  /** The runner for a request's host, or what to say instead. */
  lookup(host: string): Running | { status: number; message: string } {
    this.forgetRemoved();
    const site = this.list.find(host);
    if (!site) return { status: 404, message: "No site is previewed at this address." };
    const key = hostname(site.host);
    const existing = this.running.get(key);
    if (existing && existing.site.path === site.path) return existing;
    if (existing) this.stop(key);

    const found = devCommand(site.path);
    if ("problem" in found) return { status: 503, message: found.problem };
    const options: PreviewOptions = {
      source: site.path,
      command: found.command,
      port: this.options.port,
      upstreamPort: this.freePort(),
      idle: this.options.idle,
      startTimeout: this.options.startTimeout,
      log: (line) => this.options.log(`[${key}] ${line}`),
      env: { PREVIEW_HOST: key, BROWSER: "none" },
    };
    const entry = { site, options, runner: new PreviewRunner(options) };
    this.running.set(key, entry);
    return entry;
  }

  stopAll(): void {
    for (const key of Array.from(this.running.keys())) this.stop(key);
  }

  status() {
    return this.list
      .current()
      .map((site) =>
        Object.assign(
          { host: site.host, name: site.name },
          this.running.get(hostname(site.host))?.runner.status() ?? { state: "stopped" },
        ),
      );
  }

  /** A site disconnected in the studio stops being served, and its dev server stops. */
  private forgetRemoved(): void {
    const listed = new Set(this.list.current().map((site) => hostname(site.host)));
    for (const key of this.running.keys()) if (!listed.has(key)) this.stop(key);
  }

  private stop(key: string): void {
    const entry = this.running.get(key);
    if (!entry) return;
    entry.runner.stop();
    this.ports.delete(entry.options.upstreamPort);
    this.running.delete(key);
  }

  private freePort(): number {
    let port = this.options.firstUpstream;
    while (this.ports.has(port)) port++;
    this.ports.add(port);
    return port;
  }
}

function notice(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(
    previewPage({
      title: status === 404 ? "No preview at this address" : "This site cannot be previewed",
      lines: [message],
      note:
        status === 404
          ? "Previews appear here once the site is connected in the studio."
          : "Fix that in the site's repository, and the next visit starts it.",
    }),
  );
}

export function createPreviewSitesServer(options: PreviewSitesOptions) {
  const sites = new PreviewSites(options);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const found = sites.lookup(req.headers.host ?? "");
    if ("status" in found) return notice(res, found.status, found.message);
    if (req.url === WARM_PATH) {
      found.runner.touch();
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    if (req.url === STATUS_PATH) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(found.runner.status()));
      return;
    }
    found.runner.touch();
    proxy(found.options, found.runner)(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const found = sites.lookup(req.headers.host ?? "");
    if ("status" in found) return socket.destroy();
    found.runner.touch();
    upgrade(found.options)(req, socket, head);
  });
  return { server, sites };
}

export function previewSitesOptionsFromEnv(env: NodeJS.ProcessEnv): PreviewSitesOptions {
  const number = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be a positive number.`);
    return value;
  };
  return {
    sitesFile: env.PREVIEW_SITES as string,
    port: number("PREVIEW_PORT", 4321),
    firstUpstream: number("PREVIEW_UPSTREAM", 4400),
    idle: number("PREVIEW_IDLE", 900),
    startTimeout: number("PREVIEW_START_TIMEOUT", 600),
    log: (line) => process.stdout.write(`${new Date().toISOString()} preview ${line}\n`),
  };
}

export async function previewSitesMain(env: NodeJS.ProcessEnv): Promise<number> {
  let options: PreviewSitesOptions;
  try {
    options = previewSitesOptionsFromEnv(env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const { server, sites } = createPreviewSitesServer(options);
  await new Promise<void>((resolve) => server.listen(options.port, "0.0.0.0", resolve));
  options.log(
    `listening on ${options.port} for the sites in ${options.sitesFile}; each starts on its first request`,
  );
  const shutdown = () => {
    sites.stopAll();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<number>(() => {});
}

/**
 * `greatcms-preview` for many sites: one proxy, routed by the host a request names, with each
 * site's dev server started on first use and stopped when idle. The studio writes the list of
 * sites, so connecting a site in the studio is all it takes to preview it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import {
  commonOptionsFromEnv,
  harden,
  HEALTH_PATH,
  previewPage,
  type PreviewOptions,
  PreviewRunner,
  proxy,
  STATUS_PATH,
  untilSignalled,
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
  /** Dev servers running at once; starting one more stops the longest unused. Six by default. */
  maxRunning?: number;
  /** Megabytes of heap each dev server's Node may use. */
  siteMemory?: number;
  /** Installs without the packages' own install scripts. */
  ignoreScripts?: boolean;
  passEnv?: string[];
  upstreamTimeout?: number;
  maxBody?: number;
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

/** A JSON object's keys, or none when the site wrote something else there. */
function names(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The shell command that starts a site's dev server on $PORT, or why there is none. */
export function devCommand(
  path: string,
  options: { ignoreScripts?: boolean } = {},
): { command: string } | { problem: string } {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  } catch {
    return { problem: "The site has no package.json, so there is no dev server to start." };
  }
  // Only ever looked up by name: nothing the site wrote becomes part of the command.
  const manifest = names(pkg);
  const deps = { ...names(manifest.dependencies), ...names(manifest.devDependencies) };
  const [, install, runner] = INSTALLS.find(([lockfile]) => existsSync(join(path, lockfile))) ?? [
    "",
    "npm install",
    "npm",
  ];
  const framework = FRAMEWORKS.find(([dependency]) => Object.hasOwn(deps, dependency));
  const start = framework
    ? `exec node_modules/.bin/${framework[1]}`
    : typeof names(manifest.scripts).dev === "string"
      ? `exec ${runner} run dev`
      : null;
  if (!start) {
    return {
      problem:
        'The site uses no framework this service knows (Astro, Next.js, Nuxt, SvelteKit, Vite) and has no "dev" script.',
    };
  }
  const installed = existsSync(join(path, "node_modules"));
  const installing = options.ignoreScripts ? `${install} --ignore-scripts` : install;
  return { command: installed ? start : `${installing} && ${start}` };
}

const MAX_LIST_BYTES = 1024 * 1024;
const MAX_SITES = 500;
const HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** One spelling for a host: no case, no port, no trailing dot. */
export function hostname(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Reads the studio's list again whenever the file changes. */
export class SiteList {
  /** Goes up each time the list changes, so a caller knows when to look again. */
  revision = 0;
  private sites: PreviewSite[] = [];
  private byHost = new Map<string, PreviewSite>();
  private stamp = "";

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  current(): PreviewSite[] {
    let stamp = "missing";
    let size = 0;
    try {
      const info = statSync(this.file);
      stamp = `${info.mtimeMs}:${info.size}:${info.ino}`;
      size = info.size;
    } catch {
      // No list is no sites.
    }
    if (stamp === this.stamp) return this.sites;
    this.stamp = stamp;
    if (stamp === "missing") return this.keep([]);
    // Unreadable, half-written or absurd: the last good list stands until the next change.
    if (size > MAX_LIST_BYTES) {
      this.log(`${this.file} is larger than ${MAX_LIST_BYTES} bytes: ignored`);
      return this.sites;
    }
    let listed: unknown;
    try {
      listed = (JSON.parse(readFileSync(this.file, "utf8")) as { sites?: unknown } | null)?.sites;
    } catch (error) {
      this.log(`${this.file} could not be read: ${(error as Error).message}`);
      return this.sites;
    }
    if (!Array.isArray(listed)) {
      this.log(`${this.file} has no "sites" list: ignored`);
      return this.sites;
    }
    const sites: PreviewSite[] = [];
    const seen = new Set<string>();
    for (const entry of listed.slice(0, MAX_SITES) as Array<Partial<PreviewSite> | null>) {
      const host = typeof entry?.host === "string" ? hostname(entry.host) : "";
      const path = typeof entry?.path === "string" ? entry.path : "";
      // A second site at a taken name would be handed the first one's visitors.
      if (!HOST.test(host) || !isAbsolute(path) || path.includes("\0") || seen.has(host)) {
        this.log(`${this.file}: skipped the entry for host ${JSON.stringify(entry?.host)}`);
        continue;
      }
      seen.add(host);
      sites.push({ id: String(entry?.id ?? host), name: String(entry?.name ?? host), host, path });
    }
    if (listed.length > MAX_SITES) this.log(`${this.file}: only the first ${MAX_SITES} are used`);
    return this.keep(sites);
  }

  find(host: string): PreviewSite | undefined {
    this.current();
    return this.byHost.get(hostname(host));
  }

  private keep(sites: PreviewSite[]): PreviewSite[] {
    this.sites = sites;
    this.byHost = new Map(sites.map((site) => [site.host, site]));
    this.revision++;
    return sites;
  }
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
  /** A port stays taken until the dev server that had it has really exited. */
  private readonly ports = new Set<number>();
  private readonly retired = new Set<PreviewRunner>();
  private seen = -1;

  constructor(private readonly options: PreviewSitesOptions) {
    this.list = new SiteList(options.sitesFile, options.log);
  }

  /** The runner for a request's host, or what to say instead. */
  lookup(host: string): Running | { status: number; message: string } {
    const site = this.list.find(host);
    this.forgetRemoved();
    if (!site) return { status: 404, message: "No site is previewed at this address." };
    const key = site.host;
    const existing = this.running.get(key);
    if (existing && existing.site.path !== site.path) this.stop(key);
    else if (existing && existing.runner.state !== "stopped") return existing;

    // Asked again at each start: node_modules may have appeared, or the framework changed.
    const found = devCommand(site.path, { ignoreScripts: this.options.ignoreScripts });
    if ("problem" in found) return { status: 503, message: found.problem };
    const stopped = this.running.get(key);
    if (stopped) {
      stopped.options.command = found.command;
      return stopped;
    }
    const memory = this.options.siteMemory;
    const options: PreviewOptions = {
      source: site.path,
      command: found.command,
      port: this.options.port,
      upstreamPort: this.freePort(),
      nextPort: () => this.freePort(),
      idle: this.options.idle,
      startTimeout: this.options.startTimeout,
      upstreamTimeout: this.options.upstreamTimeout,
      maxBody: this.options.maxBody,
      passEnv: this.options.passEnv,
      log: (line) => this.options.log(`[${key}] ${line}`),
      env: {
        PREVIEW_HOST: key,
        BROWSER: "none",
        ...(memory
          ? {
              NODE_OPTIONS:
                `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${memory}`.trim(),
            }
          : {}),
      },
    };
    const entry = { site, options, runner: new PreviewRunner(options) };
    this.running.set(key, entry);
    return entry;
  }

  /** A request for a site: start it if needed, stopping the longest unused one to make room. */
  touch(entry: Running): void {
    if (entry.runner.state === "stopped") {
      const others = Array.from(this.running.values())
        .filter((each) => each !== entry && each.runner.state !== "stopped")
        .toSorted((a, b) => a.runner.lastRequest - b.runner.lastRequest);
      const room = (this.options.maxRunning ?? 6) - 1;
      for (const oldest of others.slice(0, Math.max(others.length - room, 0))) {
        this.options.log(`[${oldest.site.host}] stopped to make room for ${entry.site.host}`);
        oldest.runner.stop();
      }
    }
    entry.runner.touch();
  }

  stopAll(): void {
    for (const key of Array.from(this.running.keys())) this.stop(key);
  }

  /** Every runner that may still have a process, the ones already let go included. */
  runners(): PreviewRunner[] {
    return [...Array.from(this.running.values(), (entry) => entry.runner), ...this.retired];
  }

  status() {
    return this.list
      .current()
      .map((site) =>
        Object.assign(
          { host: site.host, name: site.name },
          this.running.get(site.host)?.runner.status() ?? { state: "stopped" },
        ),
      );
  }

  /** A site disconnected in the studio stops being served, and its dev server stops. */
  private forgetRemoved(): void {
    if (this.seen === this.list.revision) return;
    this.seen = this.list.revision;
    const listed = new Set(this.list.current().map((site) => site.host));
    for (const key of Array.from(this.running.keys())) if (!listed.has(key)) this.stop(key);
  }

  private stop(key: string): void {
    const entry = this.running.get(key);
    if (!entry) return;
    const { runner, options } = entry;
    runner.stop();
    this.running.delete(key);
    this.retired.add(runner);
    void runner.gone().then(() => {
      this.retired.delete(runner);
      this.ports.delete(options.upstreamPort);
    });
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
  // One handler per site, made once and kept with the options its runner was given.
  const passes = new WeakMap<PreviewOptions, ReturnType<typeof proxy>>();
  const server = harden(createServer());
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === HEALTH_PATH) return void res.writeHead(200).end("ok");
    const found = sites.lookup(req.headers.host ?? "");
    if ("status" in found) return notice(res, found.status, found.message);
    if (req.url === STATUS_PATH) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(found.runner.status()));
      return;
    }
    sites.touch(found);
    if (req.url === WARM_PATH) {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    let pass = passes.get(found.options);
    if (!pass) passes.set(found.options, (pass = proxy(found.options, found.runner)));
    pass(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const found = sites.lookup(req.headers.host ?? "");
    if ("status" in found) return socket.destroy();
    sites.touch(found);
    upgrade(found.options, found.runner)(req, socket, head);
  });
  return { server, sites };
}

export function previewSitesOptionsFromEnv(env: NodeJS.ProcessEnv): PreviewSitesOptions {
  const { number, ...common } = commonOptionsFromEnv(env);
  return {
    ...common,
    sitesFile: env.PREVIEW_SITES as string,
    firstUpstream: number("PREVIEW_UPSTREAM", 4400),
    startTimeout: number("PREVIEW_START_TIMEOUT", 600),
    maxRunning: number("PREVIEW_MAX_RUNNING", 6),
    siteMemory: env.PREVIEW_SITE_MEMORY ? number("PREVIEW_SITE_MEMORY", 0) : undefined,
    ignoreScripts: env.PREVIEW_IGNORE_SCRIPTS === "1",
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
  await new Promise<void>((resolve) =>
    server.listen(options.port, env.PREVIEW_BIND || "0.0.0.0", resolve),
  );
  options.log(
    `listening on ${options.port} for the sites in ${options.sitesFile}; each starts on its first request`,
  );
  return untilSignalled(server, () => sites.runners(), options.log);
}

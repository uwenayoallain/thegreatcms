/**
 * `greatcms-preview`: a site's dev server, running only while someone looks at it. A small
 * proxy sits where the dev server would; the first request starts the server, every request
 * keeps it alive, and silence stops it. Editors cost a dev server while they edit, and nothing
 * for the rest of the day.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  Agent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
  createServer,
  request,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Duplex } from "node:stream";
import { previewSitesMain } from "./previews.js";

export interface PreviewOptions {
  /** The site's working copy, where the command runs. */
  source: string;
  /** Starts the dev server; it must listen on `upstreamPort`, which is passed as `PORT`. */
  command: string;
  /** Where this proxy listens. */
  port: number;
  /** Where the dev server listens, on this machine. */
  upstreamPort: number;
  /** Seconds without a request before the dev server is stopped. */
  idle: number;
  /** Seconds the dev server may take to answer its first request. */
  startTimeout: number;
  log: (line: string) => void;
  /** More environment for the dev server, such as the public name it answers to. */
  env?: Record<string, string>;
  /** Names of this process's own variables the dev server also gets, beyond the usual ones. */
  passEnv?: string[];
  /** Seconds a running dev server may leave every request unanswered before it is restarted. */
  upstreamTimeout?: number;
  /** The largest request body passed on, in bytes. */
  maxBody?: number;
  /** Another port to try when `upstreamPort` is held by something else. */
  nextPort?: () => number;
}

export type PreviewState = "stopped" | "starting" | "running";

export const STATUS_PATH = "/__greatcms/preview";
/** Answers 200 whatever host is named: what a container healthcheck asks. */
export const HEALTH_PATH = "/__greatcms/health";

const ENV_NAMES = new Set(
  "PATH HOME USER LOGNAME SHELL LANG LANGUAGE TZ TERM TMPDIR NODE_ENV NODE_OPTIONS NODE_EXTRA_CA_CERTS PNPM_HOME CI FORCE_COLOR NO_COLOR PREVIEW_HOST HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy".split(
    " ",
  ),
);
const ENV_SHAPES =
  /^(LC_|XDG_|COREPACK_|npm_config_|PUBLIC_|VITE_|NEXT_PUBLIC_|NUXT_PUBLIC_)|_TELEMETRY_DISABLED$/;

/** What a site's code sees of this process's environment: what its tools need, and what is public by name. */
export function siteEnv(env: NodeJS.ProcessEnv, also: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_NAMES.has(name) || ENV_SHAPES.test(name) || also.includes(name)) out[name] = value;
  }
  return out;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Signals the whole process group, so whatever the shell started goes with it. */
function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, name);
  } catch {
    // The group is already gone.
  }
}

const GRACE_MS = 5000;
/** A dev server that dies sooner than this after answering counts as a failed start. */
const SETTLED_MS = 30_000;

/** Keeps one dev server, started lazily and stopped when forgotten. */
export class PreviewRunner {
  state: PreviewState = "stopped";
  lastRequest = 0;
  startedAt = 0;
  /** When the dev server last answered anything, which tells a hung one from one slow page. */
  lastAnswer = 0;
  /** Whether this start installs the site's packages first, which is the slow part. */
  get installing(): boolean {
    return /\binstall\b|\bnpm ci\b/.test(this.options.command);
  }
  /** Whether a dev server of this runner's own exists: before that, the port is someone else's. */
  get spawned(): boolean {
    return this.child !== undefined;
  }
  private child: ChildProcess | undefined;
  /** Stopped but not yet exited: they still hold the port. */
  private readonly leaving = new Set<ChildProcess>();
  private timer: NodeJS.Timeout | undefined;
  private failure: string | undefined;
  private failures = 0;
  private retryAt = 0;
  private readyAt = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly options: PreviewOptions) {}

  /** A request arrived: start if needed, and push the idle deadline back. */
  touch(): void {
    this.lastRequest = Date.now();
    // A site that keeps failing is not started again on every reload.
    if (this.state !== "stopped" || Date.now() < this.retryAt) return;
    this.state = "starting";
    this.startedAt = Date.now();
    this.failure = undefined;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
    if (!this.leaving.size) void this.spawn();
  }

  private async spawn(): Promise<void> {
    const { options } = this;
    // oxlint-disable-next-line no-await-in-loop -- one port is tried at a time
    for (let tries = 0; !(await portFree(options.upstreamPort)); tries++) {
      if (this.state !== "starting" || this.child) return;
      if (tries >= 20) {
        this.fail(`could not start: port ${options.upstreamPort} is in use by something else`);
        return this.stop();
      }
      if (options.nextPort) {
        options.log(`port ${options.upstreamPort} is taken; trying another`);
        options.upstreamPort = options.nextPort();
      } else {
        // oxlint-disable-next-line no-await-in-loop -- the one port there is may be on its way to free
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (this.state !== "starting" || this.child || this.leaving.size) return;
    options.log(`starting: ${options.command}`);
    // Its own process group, so stopping it also stops whatever the shell started.
    const child = spawn(options.command, {
      cwd: options.source,
      shell: true,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...siteEnv(process.env, options.passEnv),
        ...options.env,
        HOST: "127.0.0.1",
        PORT: String(options.upstreamPort),
        // Only ever seen inside the studio: frameworks skip their dev toolbars, which cost round trips.
        GREATCMS_PREVIEW_SERVER: "1",
      },
    });
    this.child = child;
    let over = false;
    const exited = (how: string) => {
      if (over) return;
      over = true;
      this.exited(child, how);
    };
    child.on("error", (error) => exited(error.message));
    child.on("exit", (code, name) => exited(String(code ?? name ?? "a signal")));
  }

  private exited(child: ChildProcess, how: string): void {
    this.options.log(`dev server exited (${how})`);
    // Whatever it left behind in its group would keep the port.
    signal(child, "SIGKILL");
    if (this.leaving.delete(child)) {
      if (!this.leaving.size && this.state === "starting" && !this.child) void this.spawn();
    } else if (this.child === child) {
      const starting = this.state === "starting";
      this.child = undefined;
      this.state = "stopped";
      clearInterval(this.timer);
      if (starting) this.fail(`exited with ${how} while starting`);
      else if (Date.now() - this.readyAt < SETTLED_MS)
        this.fail(`exited with ${how} soon after starting`);
    }
    this.settle();
  }

  private fail(reason: string): void {
    this.failure = reason;
    this.failures++;
    const wait = Math.min(60_000, 1000 * 2 ** (this.failures - 1));
    this.retryAt = Date.now() + wait;
    this.options.log(`${reason}; not tried again for ${wait / 1000}s`);
  }

  private tick(): void {
    if (this.state === "starting") {
      if (Date.now() - this.startedAt > this.options.startTimeout * 1000) {
        this.fail(`did not answer within ${this.options.startTimeout}s`);
        this.stop();
      }
      return;
    }
    if (this.failures && Date.now() - this.readyAt > SETTLED_MS) this.failures = 0;
    if (Date.now() - this.lastRequest > this.options.idle * 1000) {
      this.options.log(`idle for ${this.options.idle}s: stopping`);
      this.stop();
    }
  }

  /** The upstream answered: from here on requests are proxied straight through. */
  ready(): void {
    this.lastAnswer = Date.now();
    if (this.state === "starting") {
      this.state = "running";
      this.readyAt = Date.now();
      this.options.log(`ready in ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`);
    }
  }

  /** A request went unanswered: restart, unless the dev server answered something else meanwhile. */
  unanswered(seconds: number): void {
    if (this.state !== "running" || Date.now() - this.lastAnswer < seconds * 1000) return;
    this.fail(`stopped answering for ${seconds}s`);
    this.stop();
  }

  stop(): void {
    clearInterval(this.timer);
    const { child } = this;
    this.state = "stopped";
    this.child = undefined;
    if (!child) return;
    this.leaving.add(child);
    signal(child, "SIGTERM");
    const kill = setTimeout(() => signal(child, "SIGKILL"), GRACE_MS);
    child.once("exit", () => clearTimeout(kill));
  }

  /** Resolves once nothing this runner started is left, so its port can be given away. */
  gone(): Promise<void> {
    if (!this.child && !this.leaving.size) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** For the moment this process itself ends: nothing may outlive it. */
  killNow(): void {
    if (this.child) signal(this.child, "SIGKILL");
    for (const child of this.leaving) signal(child, "SIGKILL");
  }

  private settle(): void {
    if (this.child || this.leaving.size) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  status() {
    const wait = Math.ceil((this.retryAt - Date.now()) / 1000);
    return {
      state: this.state,
      failure: this.failure,
      retryInSeconds: this.state === "stopped" && wait > 0 ? wait : undefined,
      lastRequest: this.lastRequest ? new Date(this.lastRequest).toISOString() : null,
      idleSeconds: this.options.idle,
    };
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] as string);
}

/**
 * The one page the preview service shows instead of a site: plain and neutral, so it sits as well
 * inside the studio's frame as in a tab of its own, light or dark, with nothing that moves.
 */
export function previewPage(options: {
  title: string;
  lines: string[];
  note?: string;
  /** Seconds before the browser asks again, while there is something to wait for. */
  refresh?: number;
}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title>
${options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}">` : ""}
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
:root{--bg:#f6f6f4;--ink:#16181b;--muted:#5d6168;--line:#dcddd8}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--ink:#e8e9eb;--muted:#a3a7ad;--line:#2c2f34}}
html{background:var(--bg);color:var(--ink);scrollbar-gutter:stable}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(30rem,100% - 3rem);padding:2rem 0}
p{margin:0 0 .5rem;color:var(--muted)}
h1{margin:0 0 .75rem;font-size:1.15rem;font-weight:600;letter-spacing:-.01em}
.label{font-size:.75rem;letter-spacing:.06em;text-transform:uppercase}
.note{margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.85rem}
</style></head>
<body><main>
<p class="label">Preview</p>
<h1>${escapeHtml(options.title)}</h1>
${options.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
${options.note ? `<p class="note">${escapeHtml(options.note)}</p>` : ""}
</main></body></html>`;
}

/** The page the browser sees while the dev server comes up; it asks again every two seconds. */
export function waitingPage(runner: PreviewRunner): string {
  const { failure, retryInSeconds } = runner.status();
  if (failure && runner.state === "stopped") {
    return previewPage({
      title: "The preview did not start",
      lines: [`The site's dev server ${failure}.`],
      note: retryInSeconds
        ? `Its output is in the preview service's log. It can be tried again in ${retryInSeconds}s: reload this page then.`
        : "Its output is in the preview service's log. Reload this page to try again.",
    });
  }
  return previewPage({
    title: "Starting the preview",
    lines: [
      runner.installing
        ? "Installing the site's packages, then starting its dev server."
        : "Starting the site's dev server.",
      "This page shows the site once it answers.",
    ],
    note: "The preview runs only while someone is editing, so the first look after a quiet spell takes a moment.",
    refresh: 2,
  });
}

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The headers that belong to the message rather than to one connection. */
function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP.has(name) && !named.has(name)) out[name] = value;
  }
  return out;
}

/** The studio's cookies open every preview, so no site's code is handed them. */
function withoutStudioCookies(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  if (typeof headers.cookie !== "string") return headers;
  const kept = headers.cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !/^greatcms_/i.test(pair));
  if (kept.length) headers.cookie = kept.join("; ");
  else delete headers.cookie;
  return headers;
}

// A page asks a dev server for many small files at once; connections to it are kept and reused.
const upstreamAgent = new Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32 });

function page(res: ServerResponse, status: number, html: string): void {
  if (res.destroyed) return;
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function tooLarge(res: ServerResponse): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(413, { connection: "close" });
  res.end("The request is larger than the preview passes on.");
}

export function proxy(options: PreviewOptions, runner: PreviewRunner) {
  const limit = options.maxBody ?? 64 * 1024 * 1024;
  const patience = options.upstreamTimeout ?? 120;
  return (req: IncomingMessage, res: ServerResponse) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) return tooLarge(res);
    // Nothing of this site's is listening yet, so whatever answers on the port is not the site.
    if (!runner.spawned) return page(res, 503, waitingPage(runner));
    const headers = withoutStudioCookies(endToEnd(req.headers));
    if (req.headers["transfer-encoding"]) headers["transfer-encoding"] = "chunked";
    let settled = false;
    const upstream = request(
      {
        host: "127.0.0.1",
        port: options.upstreamPort,
        method: req.method,
        path: req.url,
        headers,
        agent: upstreamAgent,
      },
      (answer) => {
        clearTimeout(waiting);
        settled = true;
        runner.ready();
        res.writeHead(answer.statusCode ?? 502, endToEnd(answer.headers));
        answer.pipe(res);
        answer.on("error", () => res.destroy());
      },
    );
    // Taking the request and then saying nothing is a hung dev server, not a starting one.
    const waiting = setTimeout(() => {
      settled = true;
      runner.unanswered(patience);
      upstream.destroy();
      page(
        res,
        504,
        previewPage({
          title: "The preview is not answering",
          lines: ["The site's dev server took too long over this page."],
          note: "It is restarted when it answers nothing at all. This page asks again by itself.",
          refresh: 5,
        }),
      );
    }, patience * 1000);
    upstream.on("error", () => {
      clearTimeout(waiting);
      if (settled) return void res.destroy();
      // Not up yet, or just gone: the waiting page keeps the browser asking.
      page(res, runner.state === "running" ? 502 : 503, waitingPage(runner));
    });
    res.on("close", () => {
      clearTimeout(waiting);
      if (res.writableFinished) return;
      settled = true;
      upstream.destroy();
    });
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received <= limit || settled) return;
      settled = true;
      clearTimeout(waiting);
      req.unpipe(upstream);
      upstream.destroy();
      tooLarge(res);
    });
    req.pipe(upstream);
  };
}

/** WebSockets carry the dev server's reloads; they are passed through socket to socket. */
export function upgrade(options: PreviewOptions, runner: PreviewRunner) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!runner.spawned) return void socket.destroy();
    const upstream = request({
      host: "127.0.0.1",
      port: options.upstreamPort,
      method: req.method,
      path: req.url,
      headers: withoutStudioCookies({ ...req.headers }),
      // One socket each, never returned to a pool.
      agent: false,
    });
    // A dev server that accepts and never answers must not hold the browser's socket forever.
    const waiting = setTimeout(() => upstream.destroy(), 30_000);
    // Nothing else listens on a socket the HTTP server has handed over, and an unheard error ends the process.
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("upgrade", (answer, upstreamSocket, upstreamHead) => {
      clearTimeout(waiting);
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [name, value] of Object.entries(answer.headers)) {
        for (const each of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${each}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
    });
    // A refusal, such as Vite's answer to a socket without its token, goes back as it came:
    // left unanswered, the browser would wait on it forever.
    upstream.on("response", (answer) => {
      clearTimeout(waiting);
      const lines = [`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}`.trim()];
      for (const [name, value] of Object.entries(endToEnd(answer.headers))) {
        for (const each of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${each}`);
      }
      lines.push("connection: close");
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      answer.pipe(socket);
      answer.on("error", () => socket.destroy());
    });
    upstream.on("error", () => {
      clearTimeout(waiting);
      socket.destroy();
    });
    upstream.end();
  };
}

/** Bounds a slow or oversized request, and outlasts the idle connections of the proxy in front. */
export function harden(server: Server): Server {
  server.headersTimeout = 20_000;
  server.requestTimeout = 300_000;
  // Longer than Caddy keeps an idle connection, so it never reuses one this side has closed.
  server.keepAliveTimeout = 125_000;
  server.maxHeadersCount = 200;
  return server;
}

/** Runs until told to stop, and leaves no dev server behind however this process ends. */
export function untilSignalled(
  server: Server,
  runners: () => PreviewRunner[],
  log: (line: string) => void,
): Promise<number> {
  process.on("exit", () => {
    for (const runner of runners()) runner.killNow();
  });
  return new Promise<number>(() => {
    let leaving = false;
    const shutdown = () => {
      if (leaving) return;
      leaving = true;
      log("stopping");
      server.close();
      server.closeAllConnections();
      const all = runners();
      for (const runner of all) runner.stop();
      const limit = new Promise((done) => setTimeout(done, GRACE_MS + 1000));
      void Promise.race([Promise.all(all.map((runner) => runner.gone())), limit]).then(() =>
        process.exit(0),
      );
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

export function createPreviewServer(options: PreviewOptions) {
  const runner = new PreviewRunner(options);
  const pass = proxy(options, runner);
  const passUpgrade = upgrade(options, runner);
  const server = harden(createServer());
  server.on("request", (req, res) => {
    if (req.url === HEALTH_PATH) return void res.writeHead(200).end("ok");
    if (req.url === STATUS_PATH) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(runner.status()));
      return;
    }
    runner.touch();
    pass(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    runner.touch();
    passUpgrade(req, socket, head);
  });
  return { server, runner };
}

export const PREVIEW_HELP = `greatcms-preview: a site's dev server, running only while someone looks at it.

Environment:
  PREVIEW_SOURCE    the site's working copy                                   (required)
  PREVIEW_COMMAND   starts the dev server on $PORT   (default: pnpm install --frozen-lockfile && pnpm exec astro dev --host 127.0.0.1 --port $PORT)
  PREVIEW_PORT      where this proxy listens                                   (default: 4321)
  PREVIEW_BIND      the address it listens on                                  (default: 0.0.0.0)
  PREVIEW_UPSTREAM  where the dev server listens                               (default: 4322)
  PREVIEW_IDLE      seconds without a request before it is stopped             (default: 900)
  PREVIEW_START_TIMEOUT  seconds it may take to answer                         (default: 300)
  PREVIEW_UPSTREAM_TIMEOUT  seconds of no answer at all before a restart       (default: 120)
  PREVIEW_MAX_BODY  megabytes of request body passed on                        (default: 64)
  PREVIEW_ENV       names of more variables the dev server gets, comma separated

The dev server sees PATH, HOME and the like, anything named PUBLIC_*, VITE_*, NEXT_PUBLIC_*,
NUXT_PUBLIC_*, npm_config_* or *_TELEMETRY_DISABLED, and what PREVIEW_ENV names: nothing else of
this process's environment. A dev server that keeps failing is retried with a growing wait.

Point the studio's dev URL (through your proxy) at PREVIEW_PORT. GET /__greatcms/preview reports
the state; GET /__greatcms/health answers 200 while the proxy is up.

Many sites from one process, routed by the host each request names:
  PREVIEW_SITES     the list the studio writes (STUDIO_PREVIEWS_FILE); replaces PREVIEW_SOURCE
  PREVIEW_UPSTREAM  the first port a dev server is given; each site gets the next free one
  PREVIEW_MAX_RUNNING  dev servers running at once; the longest unused is stopped   (default: 6)
  PREVIEW_SITE_MEMORY  megabytes of heap each dev server's Node may use         (default: no limit)
  PREVIEW_IGNORE_SCRIPTS  1 installs with --ignore-scripts
Each site's dev server is found from its package.json (Astro, Next.js, Nuxt, SvelteKit, Vite, or
its "dev" script), with its dependencies installed first when it has no node_modules.
`;

/** The settings both ways of running share. */
export function commonOptionsFromEnv(env: NodeJS.ProcessEnv) {
  const number = (name: string, fallback: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be a positive number.`);
    return value;
  };
  return {
    number,
    port: number("PREVIEW_PORT", 4321),
    idle: number("PREVIEW_IDLE", 900),
    upstreamTimeout: number("PREVIEW_UPSTREAM_TIMEOUT", 120),
    maxBody: number("PREVIEW_MAX_BODY", 64) * 1024 * 1024,
    passEnv: (env.PREVIEW_ENV ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    log: (line: string) => process.stdout.write(`${new Date().toISOString()} preview ${line}\n`),
  };
}

export function previewOptionsFromEnv(env: NodeJS.ProcessEnv): PreviewOptions {
  if (!env.PREVIEW_SOURCE) throw new Error(`PREVIEW_SOURCE must be set.\n\n${PREVIEW_HELP}`);
  const { number, ...common } = commonOptionsFromEnv(env);
  return {
    ...common,
    source: env.PREVIEW_SOURCE,
    command:
      env.PREVIEW_COMMAND ||
      "pnpm install --frozen-lockfile && pnpm exec astro dev --host 127.0.0.1 --port $PORT",
    upstreamPort: number("PREVIEW_UPSTREAM", 4322),
    startTimeout: number("PREVIEW_START_TIMEOUT", 300),
  };
}

export async function previewMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(PREVIEW_HELP);
    return 0;
  }
  if (env.PREVIEW_SITES) return previewSitesMain(env);
  let options: PreviewOptions;
  try {
    options = previewOptionsFromEnv(env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const { server, runner } = createPreviewServer(options);
  await new Promise<void>((resolve) =>
    server.listen(options.port, env.PREVIEW_BIND || "0.0.0.0", resolve),
  );
  options.log(`listening on ${options.port}; dev server starts on the first request`);
  return untilSignalled(server, () => [runner], options.log);
}

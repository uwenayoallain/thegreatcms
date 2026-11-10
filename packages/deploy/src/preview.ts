/**
 * `greatcms-preview`: a site's dev server, running only while someone looks at it. A small
 * proxy sits where the dev server would; the first request starts the server, every request
 * keeps it alive, and silence stops it. Editors cost a dev server while they edit, and nothing
 * for the rest of the day.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { type IncomingMessage, type ServerResponse, createServer, request } from "node:http";
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
}

export type PreviewState = "stopped" | "starting" | "running";

export const STATUS_PATH = "/__greatcms/preview";

/** Keeps one dev server, started lazily and stopped when forgotten. */
export class PreviewRunner {
  state: PreviewState = "stopped";
  lastRequest = 0;
  startedAt = 0;
  /** Whether this start installs the site's packages first, which is the slow part. */
  get installing(): boolean {
    return /\binstall\b/.test(this.options.command);
  }
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private failure: string | undefined;

  constructor(private readonly options: PreviewOptions) {}

  /** A request arrived: start if needed, and push the idle deadline back. */
  touch(): void {
    this.lastRequest = Date.now();
    if (this.state === "stopped") this.start();
  }

  private start(): void {
    const { options } = this;
    this.state = "starting";
    this.startedAt = Date.now();
    this.failure = undefined;
    options.log(`starting: ${options.command}`);
    // Its own process group, so stopping it also stops whatever the shell started.
    this.child = spawn(options.command, {
      cwd: options.source,
      shell: true,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      // Only ever seen inside the studio: frameworks skip their dev toolbars, which cost round trips.
      env: {
        ...process.env,
        ...options.env,
        PORT: String(options.upstreamPort),
        GREATCMS_PREVIEW_SERVER: "1",
      },
    });
    this.child.on("exit", (code) => {
      options.log(`dev server exited (${code ?? "signal"})`);
      if (this.state === "starting")
        this.failure = `exited with ${code ?? "a signal"} while starting`;
      this.child = undefined;
      this.state = "stopped";
      clearInterval(this.timer);
    });
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    if (this.state === "starting") {
      if (Date.now() - this.startedAt > this.options.startTimeout * 1000) {
        this.failure = `did not answer within ${this.options.startTimeout}s`;
        this.options.log(this.failure);
        this.stop();
      }
      return;
    }
    if (Date.now() - this.lastRequest > this.options.idle * 1000) {
      this.options.log(`idle for ${this.options.idle}s: stopping`);
      this.stop();
    }
  }

  /** The upstream answered: from here on requests are proxied straight through. */
  ready(): void {
    if (this.state === "starting") {
      this.state = "running";
      this.options.log(`ready in ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    const { child } = this;
    this.state = "stopped";
    this.child = undefined;
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }

  status() {
    return {
      state: this.state,
      failure: this.failure,
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
<meta name="robots" content="noindex">
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
  const { failure } = runner.status();
  if (failure) {
    return previewPage({
      title: "The preview did not start",
      lines: [`The site's dev server ${failure}.`],
      note: "Reload this page to try again. If it keeps happening, tell whoever runs the site: the reason is in the preview service's log.",
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

export function proxy(options: PreviewOptions, runner: PreviewRunner) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const upstream = request(
      {
        host: "127.0.0.1",
        port: options.upstreamPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (answer) => {
        runner.ready();
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      // Not up yet, or just gone: the waiting page keeps the browser asking.
      if (res.headersSent) return res.destroy();
      res.writeHead(runner.state === "running" ? 502 : 503, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(waitingPage(runner));
    });
    req.pipe(upstream);
  };
}

/** WebSockets carry the dev server's reloads; they are passed through socket to socket. */
export function upgrade(options: PreviewOptions) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const upstream = request({
      host: "127.0.0.1",
      port: options.upstreamPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    });
    upstream.on("upgrade", (answer, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [name, value] of Object.entries(answer.headers)) {
        for (const each of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${each}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
    });
    // A refusal, such as Vite's answer to a socket without its token, goes back as it came:
    // left unanswered, the browser would wait on it forever.
    upstream.on("response", (answer) => {
      const lines = [`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}`.trim()];
      for (const [name, value] of Object.entries(answer.headers)) {
        if (name === "connection" || name === "keep-alive") continue;
        for (const each of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${each}`);
      }
      lines.push("connection: close");
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      answer.pipe(socket);
      socket.on("error", () => answer.destroy());
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  };
}

export function createPreviewServer(options: PreviewOptions) {
  const runner = new PreviewRunner(options);
  const server = createServer((req, res) => {
    if (req.url === STATUS_PATH) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(runner.status()));
      return;
    }
    runner.touch();
    proxy(options, runner)(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    runner.touch();
    upgrade(options)(req, socket, head);
  });
  return { server, runner };
}

export const PREVIEW_HELP = `greatcms-preview: a site's dev server, running only while someone looks at it.

Environment:
  PREVIEW_SOURCE    the site's working copy                                   (required)
  PREVIEW_COMMAND   starts the dev server on $PORT   (default: pnpm install --frozen-lockfile && pnpm exec astro dev --host 127.0.0.1 --port $PORT)
  PREVIEW_PORT      where this proxy listens                                   (default: 4321)
  PREVIEW_UPSTREAM  where the dev server listens                               (default: 4322)
  PREVIEW_IDLE      seconds without a request before it is stopped             (default: 900)
  PREVIEW_START_TIMEOUT  seconds it may take to answer                         (default: 300)

Point the studio's dev URL (through your proxy) at PREVIEW_PORT. GET /__greatcms/preview reports the state.

Many sites from one process, routed by the host each request names:
  PREVIEW_SITES     the list the studio writes (STUDIO_PREVIEWS_FILE); replaces PREVIEW_SOURCE
  PREVIEW_UPSTREAM  the first port a dev server is given; each site gets the next free one
Each site's dev server is found from its package.json (Astro, Next.js, Nuxt, SvelteKit, Vite, or
its "dev" script), with its dependencies installed first when it has no node_modules.
`;

export function previewOptionsFromEnv(env: NodeJS.ProcessEnv): PreviewOptions {
  if (!env.PREVIEW_SOURCE) throw new Error(`PREVIEW_SOURCE must be set.\n\n${PREVIEW_HELP}`);
  const number = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be a positive number.`);
    return value;
  };
  return {
    source: env.PREVIEW_SOURCE,
    command:
      env.PREVIEW_COMMAND ||
      "pnpm install --frozen-lockfile && pnpm exec astro dev --host 127.0.0.1 --port $PORT",
    port: number("PREVIEW_PORT", 4321),
    upstreamPort: number("PREVIEW_UPSTREAM", 4322),
    idle: number("PREVIEW_IDLE", 900),
    startTimeout: number("PREVIEW_START_TIMEOUT", 300),
    log: (line) => process.stdout.write(`${new Date().toISOString()} preview ${line}\n`),
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
  await new Promise<void>((resolve) => server.listen(options.port, "0.0.0.0", resolve));
  options.log(`listening on ${options.port}; dev server starts on the first request`);
  const shutdown = () => {
    runner.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<number>(() => {});
}

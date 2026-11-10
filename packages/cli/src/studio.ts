/** `greatcms studio`: the visual editor for the site in this folder, on this machine, in one command. */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Flags } from "./commands.js";
import { detectFramework } from "./detect.js";
import { CliError, UsageError } from "./ports.js";
import type { PromptPort } from "./prompt.js";
import { ui } from "./ui.js";
import { packageManager } from "./wire.js";

/** Where the studio listens unless told otherwise; the next free port after it when it is taken. */
export const DEFAULT_PORT = 4983;
/** The studio is built on `node:sqlite`, which this is the first Node to ship as it uses it. */
export const MIN_NODE = "22.13.0";
const STUDIO_PACKAGE = "@greatcms/studio";

/** Whether `version` (as `process.versions.node`) is at least `minimum`. */
export function nodeAtLeast(version: string, minimum = MIN_NODE): boolean {
  const [a = 0, b = 0, c = 0] = version.split(".").map(Number);
  const [x = 0, y = 0, z = 0] = minimum.split(".").map(Number);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

/** The nearest folder at or above `from` that holds a schema, or null. */
export function findSiteRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (["schema.yaml", "schema.yml", "schema.json"].some((n) => existsSync(join(dir, ".cms", n))))
      return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Whether a `--host` value can only be reached from this machine. */
export function isLoopback(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name);
}

/** Where the database and session secret go: never anywhere `git status` would show. */
export function stateDir(
  root: string,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (existsSync(join(root, "node_modules")))
    return join(root, "node_modules", ".cache", "greatcms");
  const cache =
    env.XDG_CACHE_HOME ||
    (platform === "darwin"
      ? join(home, "Library", "Caches")
      : platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : join(home, ".cache"));
  // One folder per site: two sites with the same name in different places do not share a database.
  const id = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return join(cache, "greatcms", `${basename(root).replace(/[^\w.-]+/g, "-") || "site"}-${id}`);
}

/** Whether nothing on this machine is listening on `port`, on either loopback address. */
export async function portFree(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((done) => {
      const probe = createServer()
        // A machine without IPv6 has nothing listening on it either.
        .once("error", (error: NodeJS.ErrnoException) => done(error.code === "EADDRNOTAVAIL"))
        .once("listening", () => probe.close(() => done(true)))
        .listen(port, host);
    });
  return (await tryHost("127.0.0.1")) && (await tryHost("::1"));
}

/** The first free port at or after `start`, skipping any already promised to something else. */
export async function choosePort(
  start: number,
  isFree: (port: number) => Promise<boolean> = portFree,
  taken: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let port = start; port < start + 100 && port <= 65_535; port += 1) {
    if (taken.has(port)) continue;
    // oxlint-disable-next-line no-await-in-loop -- each port is tried only if the last was busy
    if (await isFree(port)) return port;
  }
  throw new CliError(
    `No free port between ${start} and ${Math.min(start + 99, 65_535)}.`,
    "Pass one with --port.",
  );
}

export function parsePort(value: string, option: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new UsageError(`${option} cannot be "${value}".`, "Give it a port number, 1 to 65535.");
  }
  return port;
}

export interface DevPlan {
  /** What the terminal calls it, e.g. `astro dev`. */
  label: string;
  /** The port the framework uses when nobody says otherwise. */
  port: number;
  /** The command for a given port; the first item is the binary. */
  command(port: number): string[];
  /** The framework records its running dev server on disk, so no record means none is running. */
  recordsItself: boolean;
}

/** How each framework's dev server is told its port; the same table `greatcms-preview` uses. */
const DEV_SERVERS: Record<string, { bin: string; port: number; args(port: string): string[] }> = {
  // --ignore-lock: Astro 7 sends itself to the background when an agent runs it; this keeps it a child.
  astro: { bin: "astro", port: 4321, args: (port) => ["dev", "--port", port, "--ignore-lock"] },
  // Next listens on every interface unless told: the preview is for this machine.
  next: {
    bin: "next",
    port: 3000,
    args: (port) => ["dev", "--hostname", "localhost", "--port", port],
  },
  nuxt: { bin: "nuxt", port: 3000, args: (port) => ["dev", "--port", port] },
  sveltekit: { bin: "vite", port: 5173, args: (port) => ["dev", "--port", port, "--strictPort"] },
  vite: { bin: "vite", port: 5173, args: (port) => ["dev", "--port", port, "--strictPort"] },
};

/** The site's own dev server, or why there is none to start. */
export function devPlan(root: string): DevPlan | { problem: string } {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return { problem: "no package.json, so no dev server to start" };
  }
  let files: string[] = [];
  try {
    files = readdirSync(root);
  } catch {
    // Detection falls back to the dependencies.
  }
  const { framework } = detectFramework({ files, packageJson: pkg });
  const id =
    framework.id in DEV_SERVERS
      ? framework.id
      : { ...pkg.dependencies, ...pkg.devDependencies }.vite
        ? "vite"
        : null;
  if (!id) return { problem: "no Astro, Next.js, Nuxt, SvelteKit or Vite dev server found" };
  const server = DEV_SERVERS[id]!;
  const bin = findBin(root, server.bin);
  if (!bin) return { problem: `${server.bin} is not installed: install the site's dependencies` };
  return {
    label: `${server.bin} dev`,
    port: server.port,
    command: (port) => [bin, ...server.args(String(port))],
    recordsItself:
      id === "astro" &&
      existsSync(join(dirname(dirname(bin)), "astro", "dist", "core", "dev", "lockfile.js")),
  };
}

/**
 * Addresses this site's own dev server wrote down when it started: Astro's `.astro/dev.json` and
 * Next's `<distDir>/dev/lock`. Unlike a guess at the usual port, these can only be this site.
 */
export function recordedDevUrls(root: string): string[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const file of [
    join(root, ".astro", "dev.json"),
    ...dirs.map((dir) => join(root, dir, "dev", "lock")),
  ]) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const url = typeof data.appUrl === "string" ? data.appUrl : data.url;
      if (typeof data.pid !== "number" || typeof url !== "string") continue;
      // Signal 0 only asks whether the process exists: a stale record names one that does not.
      process.kill(data.pid, 0);
      const { protocol, origin } = new URL(url);
      if (protocol === "http:" || protocol === "https:") urls.push(origin);
    } catch {
      // Missing, half-written, or left by a server that has gone.
    }
  }
  return urls;
}

/** A package binary from the site's node_modules, or a workspace root's above it. */
function findBin(root: string, name: string): string | null {
  const file = process.platform === "win32" ? `${name}.cmd` : name;
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ".bin", file);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** Whether anything answers HTTP at `url`, whatever it says. */
export async function answers(url: string, timeoutMs = 700): Promise<boolean> {
  try {
    const reply = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await reply.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export interface DevServer {
  /** True once the address answers; false if the command exited or the wait ran out. */
  ready: Promise<boolean>;
  /** The last lines it printed, for saying why it did not start. */
  tail(): string;
  stop(): Promise<void>;
}

export interface DevServerOptions {
  command: string[];
  cwd: string;
  url: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the address to answer. */
  timeoutMs?: number;
  /** How long a stop waits before it stops asking. */
  killAfterMs?: number;
}

/**
 * Runs the site's dev command as a child of the CLI, the way a dev script would. It is given its
 * own process group so that stopping it also stops whatever it started (a package manager's
 * child, a bundler's workers), which a plain kill of one pid leaves behind.
 */
export function startDevServer(options: DevServerOptions): DevServer {
  const [file, ...args] = options.command as [string, ...string[]];
  const windows = process.platform === "win32";
  const child: ChildProcess = spawn(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !windows,
    shell: windows,
  });
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + String(chunk)).slice(-4000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const state = { exited: false };
  const gone = new Promise<void>((done) => {
    child.once("exit", () => {
      state.exited = true;
      done();
    });
    child.once("error", (error) => {
      output += `${error.message}\n`;
      state.exited = true;
      done();
    });
  });

  const signal = (name: NodeJS.Signals) => {
    if (state.exited || child.pid === undefined) return;
    try {
      if (windows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid, name);
    } catch {
      // Already gone.
    }
  };
  // A crash of the CLI itself must not leave a dev server holding the port.
  const onExit = () => signal("SIGKILL");
  process.once("exit", onExit);

  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  const ready = (async () => {
    while (!state.exited && Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- polling: each try follows the last
      if (await answers(options.url, 500)) return !state.exited;
      // oxlint-disable-next-line no-await-in-loop -- polling: each try follows the last
      await Promise.race([gone, new Promise((wake) => setTimeout(wake, 120))]);
    }
    return false;
  })();

  return {
    ready,
    tail: () =>
      output
        // oxlint-disable-next-line no-control-regex -- strips the colour codes dev servers print
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trim()
        .split("\n")
        .slice(-8)
        .join("\n"),
    async stop() {
      signal("SIGTERM");
      const forced = setTimeout(() => signal("SIGKILL"), options.killAfterMs ?? 3000);
      await gone;
      clearTimeout(forced);
      process.off("exit", onExit);
    },
  };
}

/** What `@greatcms/studio` exports for this command. */
export interface StudioModule {
  startLocal(options: {
    root: string;
    name: string;
    stateDir: string;
    port: number;
    host?: string;
    devUrl?: string;
    password?: string;
  }): Promise<{ url: string; port: number; close(): Promise<void> }>;
}

/** The studio's entry file: the site's own copy, then one beside this CLI, then a checkout's. */
export function resolveStudio(root: string, here: string = import.meta.url): string | null {
  for (const base of [pathToFileURL(join(root, "package.json")).href, here]) {
    try {
      return createRequire(base).resolve(STUDIO_PACKAGE);
    } catch {
      // Not installed there.
    }
  }
  // In a checkout of GreatCMS the studio is a sibling folder, not a dependency of the CLI.
  try {
    const sibling = fileURLToPath(new URL("../../../apps/studio/", here));
    const pkg = JSON.parse(readFileSync(join(sibling, "package.json"), "utf8")) as {
      name?: string;
    };
    const entry = join(sibling, "dist", "start.js");
    if (pkg.name === STUDIO_PACKAGE && existsSync(entry)) return entry;
  } catch {
    // Not a checkout.
  }
  return null;
}

/** The exact command that adds the studio to a site, in its own package manager. */
export function installCommand(root: string): string[] {
  let pkg: { packageManager?: unknown } | undefined;
  let files: string[] = [];
  try {
    files = readdirSync(root);
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    // No package.json: a site in another language.
  }
  if (!pkg) return ["npm", "install", "--global", STUDIO_PACKAGE];
  const manager = packageManager(files, pkg);
  return manager === "npm"
    ? ["npm", "install", "--save-dev", STUDIO_PACKAGE]
    : [manager, "add", "-D", STUDIO_PACKAGE];
}

function runInherit(command: string[], cwd: string): Promise<number> {
  return new Promise((done) => {
    const [file, ...args] = command as [string, ...string[]];
    spawn(file, args, { cwd, stdio: "inherit", shell: process.platform === "win32" })
      .once("exit", (code) => done(code ?? 1))
      .once("error", () => done(1));
  });
}

/** Opens the default browser; failing to is not an error, the address is in the terminal. */
function openBrowser(url: string): void {
  const [file, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replaceAll("&", "^&")]]
        : ["xdg-open", [url]];
  try {
    spawn(file as string, args as string[], { stdio: "ignore", detached: true })
      .once("error", () => {})
      .unref();
  } catch {
    // No opener on this machine.
  }
}

export interface StudioCommandOptions {
  cwd: string;
  flags: Flags;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompt?: PromptPort;
}

/** Everything the command touches outside its own logic, so tests can stand in for each. */
export interface StudioDeps {
  env: Record<string, string | undefined>;
  nodeVersion: string;
  /** Loads the studio for a site, or null when it is not installed. */
  load(root: string): Promise<StudioModule | null>;
  install(command: string[], root: string): Promise<number>;
  portFree(port: number): Promise<boolean>;
  answers(url: string): Promise<boolean>;
  startDev(options: DevServerOptions): DevServer;
  open(url: string): void;
  /** Resolves when the person asks to stop: Ctrl+C, or the terminal closing. */
  stopped(): Promise<void>;
}

const realDeps: StudioDeps = {
  env: process.env,
  nodeVersion: process.versions.node,
  async load(root) {
    const entry = resolveStudio(root);
    if (!entry) return null;
    // Node 22 announces node:sqlite as experimental on every start; that is not news to the person editing.
    const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
    process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
      if (!/SQLite is an experimental feature/.test(String(warning))) emit(warning, ...rest);
    }) as typeof process.emitWarning;
    return (await import(pathToFileURL(entry).href)) as StudioModule;
  },
  install: runInherit,
  portFree,
  answers,
  startDev: startDevServer,
  open: openBrowser,
  stopped: () =>
    new Promise((done) => {
      for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, () => done());
    }),
};

export async function studioCommand(
  options: StudioCommandOptions,
  overrides: Partial<StudioDeps> = {},
): Promise<number> {
  const deps = { ...realDeps, ...overrides };
  const { flags, stdout, stderr } = options;
  const u = ui();

  if (!nodeAtLeast(deps.nodeVersion)) {
    throw new CliError(
      `greatcms studio needs Node.js 22.13 or newer, and this is v${deps.nodeVersion}.`,
      "Install a current Node.js (nodejs.org, or `nvm install 22`) and run it again. The other greatcms commands work on this one.",
    );
  }

  const root = findSiteRoot(options.cwd);
  if (!root) {
    throw new CliError(
      `No .cms/schema.yaml in ${resolve(options.cwd)} or any folder above it.`,
      "Run `greatcms init` here to set the site up, then `greatcms studio`.",
    );
  }

  const host = flags.string("host") ?? "127.0.0.1";
  const password = deps.env.STUDIO_PASSWORD || undefined;
  if (!isLoopback(host) && !password) {
    throw new UsageError(
      `--host ${host} would put the studio on the network with no password: opening with no sign-in is only safe on this machine.`,
      "Drop --host to stay on 127.0.0.1, or set STUDIO_PASSWORD to a long random value and sign in with that.",
    );
  }
  const devUrlFlag = flags.string("dev-url");
  if (devUrlFlag !== undefined && !/^https?:\/\/[^\s/]+/.test(devUrlFlag)) {
    throw new UsageError(
      `--dev-url cannot be "${devUrlFlag}".`,
      "Give it the address of the site's dev server, e.g. --dev-url http://localhost:4321.",
    );
  }
  const portFlag = flags.string("port");
  const wantedPort = portFlag === undefined ? undefined : parsePort(portFlag, "--port");

  let studio = await deps.load(root);
  if (!studio) {
    const command = installCommand(root);
    const line = command.join(" ");
    const prompt = options.prompt;
    if (!prompt?.interactive) {
      throw new CliError(
        `The studio is a separate package, ${STUDIO_PACKAGE}, and it is not installed.`,
        line,
      );
    }
    stdout(
      `${u.info(`The studio is a separate package, ${STUDIO_PACKAGE}, and it is not installed.`)}\n${u.note(`It would be added with: ${line}`)}\n`,
    );
    if (!(await prompt.confirm("Install it now?", true))) {
      throw new CliError("Nothing was installed.", line);
    }
    if ((await deps.install(command, root)) !== 0) {
      throw new CliError(`\`${line}\` failed.`, "Run it yourself to see why, then try again.");
    }
    studio = await deps.load(root);
    if (!studio) throw new CliError(`${STUDIO_PACKAGE} was installed but could not be loaded.`);
  }
  if (typeof studio.startLocal !== "function") {
    throw new CliError(
      `The installed ${STUDIO_PACKAGE} is too old for this command.`,
      installCommand(root).join(" ").replace(STUDIO_PACKAGE, `${STUDIO_PACKAGE}@latest`),
    );
  }

  let port: number;
  if (wantedPort === undefined) {
    port = await choosePort(DEFAULT_PORT, deps.portFree);
  } else {
    if (!(await deps.portFree(wantedPort))) {
      throw new CliError(
        `Port ${wantedPort} is in use.`,
        "Choose another with --port, or leave it out and the next free port is used.",
      );
    }
    port = wantedPort;
  }

  // The preview: an address given, one already up, or the site's own dev command started here.
  const started = Date.now();
  let devUrl: string | undefined = devUrlFlag?.replace(/\/$/, "");
  let devNote = devUrl ? "" : "none";
  let dev: DevServer | undefined;
  if (!devUrl && flags.boolean("no-dev")) {
    devNote = "off (--no-dev)";
  } else if (!devUrl) {
    const plan = devPlan(root);
    if ("problem" in plan) {
      devNote = `none: ${plan.problem}. Pass --dev-url if one is running`;
    } else if ((devUrl = await firstAnswering(recordedDevUrls(root), deps.answers))) {
      devNote = "this site's dev server, already running";
    } else if (!plan.recordsItself && (await deps.answers(`http://localhost:${plan.port}`))) {
      devUrl = `http://localhost:${plan.port}`;
      devNote = "already running there; pass --dev-url if that is another site";
    } else {
      const devPort = await choosePort(plan.port, deps.portFree, new Set([port]));
      devUrl = `http://localhost:${devPort}`;
      devNote = `${plan.label}, starting`;
      dev = deps.startDev({ command: plan.command(devPort), cwd: root, url: devUrl });
    }
  }

  let running: Awaited<ReturnType<StudioModule["startLocal"]>>;
  try {
    running = await studio.startLocal({
      root,
      name: siteName(root),
      stateDir: stateDir(root, deps.env),
      port,
      host,
      devUrl,
      password: isLoopback(host) ? undefined : password,
    });
  } catch (error) {
    await dev?.stop();
    throw error instanceof Error && !("code" in error) ? new CliError(error.message) : error;
  }

  const origin = new URL(running.url).origin;
  stdout(
    `\n${u.kv([
      ["studio", u.bold(origin)],
      ["site", `${siteName(root)}  ${u.muted(root)}`],
      ["preview", devUrl ? `${devUrl}  ${u.muted(`(${devNote})`)}` : u.muted(devNote)],
    ])}\n\n`,
  );
  if (!isLoopback(host)) stdout(`  Sign in at ${origin} with STUDIO_PASSWORD.\n\n`);
  else if (!flags.boolean("no-open")) deps.open(origin);
  stdout(`${u.note(`Ctrl+C stops ${dev ? "the studio and the dev server" : "it"}.`)}\n`);

  if (dev) {
    const watched = dev;
    void watched.ready.then((up) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (up) stdout(`${u.ok(`Preview ready in ${seconds}s.`)}\n`);
      else {
        stderr(
          `${u.warn(`The dev server did not come up; the editor works without the preview.\n${watched.tail()}`)}\n`,
        );
      }
    });
  }

  await deps.stopped();
  await Promise.all([dev?.stop(), running.close()]);
  stdout(`\n${u.note("Stopped.")}\n`);
  return 0;
}

async function firstAnswering(
  urls: string[],
  answering: (url: string) => Promise<boolean>,
): Promise<string | undefined> {
  const up = await Promise.all(urls.map((url) => answering(url)));
  return urls.find((_url, index) => up[index]);
}

/** What the studio calls the site: its package name without the scope, else the folder's. */
function siteName(root: string): string {
  try {
    const { name } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (typeof name === "string" && name.trim()) return name.replace(/^@[^/]+\//, "");
  } catch {
    // No package.json.
  }
  return basename(root);
}

/**
 * The dev server of every site in this repository, for the tunnelled studio's live preview; list your
 * own in SITES. Runs inside the `previews`
 * container, reachable only through Caddy, which asks the studio whether a visitor is signed in.
 * Each server is told the public name it answers to, and is started again if it stops.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";

const root = process.env.SITES_DIR ?? process.cwd();
const domain = process.env.PREVIEW_DOMAIN;
if (!domain) throw new Error("PREVIEW_DOMAIN is not set.\n  fix: PREVIEW_DOMAIN=example.com");

const astro = (port) => [
  "astro",
  "dev",
  "--port",
  String(port),
  "--host",
  "0.0.0.0",
  "--ignore-lock",
];

const SITES = [
  { id: "paraline", dir: "examples/studio-astro", port: 4322, command: astro },
  { id: "example", dir: "examples/site-astro", port: 4323, command: astro },
  {
    id: "bakery",
    dir: "examples/bakery-next",
    port: 4324,
    command: (port) => ["next", "dev", "--port", String(port), "--hostname", "0.0.0.0"],
  },
  {
    id: "journal",
    dir: "examples/journal-sveltekit",
    port: 4325,
    command: (port) => ["vite", "dev", "--port", String(port), "--host", "0.0.0.0", "--strictPort"],
  },
  {
    id: "sundial",
    dir: "examples/changelog-nuxt",
    port: 4326,
    command: (port) => ["nuxt", "dev", "--port", String(port), "--host", "0.0.0.0"],
  },
  { id: "docs", dir: "apps/docs", port: 4327, command: astro },
];

function run(site, attempt = 0) {
  const [bin, ...args] = site.command(site.port);
  const cwd = join(root, site.dir);
  const child = spawn(join(cwd, "node_modules/.bin", bin), args, {
    cwd,
    env: { ...process.env, PREVIEW_HOST: `${site.id}-preview.${domain}`, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `[${site.id}] `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n"))
        if (line.trim()) process.stdout.write(tag + line + "\n");
    });
  }
  const started = Date.now();
  // A server can stay alive and stop listening, as a restart that fails halfway leaves Vite. After a
  // minute to start, three missed checks in a row stop it, and the exit below starts it again.
  let missed = 0;
  const watch = setInterval(async () => {
    if (Date.now() - started < 60_000) return;
    missed = (await listening(site.port)) ? 0 : missed + 1;
    if (missed >= 3) {
      process.stdout.write(`${tag}not answering on ${site.port}; restarting\n`);
      child.kill("SIGTERM");
    }
  }, 20_000);
  child.on("exit", (code) => {
    clearInterval(watch);
    // A server that ran for a while is restarted at once; one that keeps failing, more slowly each time.
    const next = Date.now() - started > 60_000 ? 0 : attempt + 1;
    const wait = Math.min(60_000, 2_000 * 2 ** Math.min(next, 5));
    process.stdout.write(`${tag}stopped (${code}); starting again in ${wait / 1000}s\n`);
    setTimeout(() => run(site, next), wait);
  });
}

/** Whether anything accepts a connection on the port, inside this container. */
function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 2000 });
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

for (const site of SITES) run(site);

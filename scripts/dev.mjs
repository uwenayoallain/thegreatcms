/**
 * `pnpm dev`: the studio and every example site, already connected, in one command.
 * The studio rebuilds on change; the sites are their frameworks' own dev servers, which the studio frames.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = join(root, "apps/studio/data");
mkdirSync(data, { recursive: true });

// Sessions survive restarts in development, so a rebuild does not sign you out.
const secretFile = join(data, "dev-secret");
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"));

const password = process.env.STUDIO_PASSWORD || "greatcms-dev";
const sites = [
  {
    id: "paraline",
    name: "Paraline (showcase)",
    dir: "examples/studio-astro",
    pkg: "@greatcms/example-studio-astro",
    port: 4322,
  },
  {
    id: "example",
    name: "Minimal Astro site",
    dir: "examples/site-astro",
    pkg: "@greatcms/example-site-astro",
    port: 4323,
  },
  {
    id: "bakery",
    name: "Hearth (Next.js)",
    dir: "examples/bakery-next",
    pkg: "@greatcms/example-bakery-next",
    port: 4324,
    serve: (port) => ["exec", "next", "dev", "--port", String(port)],
  },
  {
    id: "journal",
    name: "The Long Light (SvelteKit)",
    dir: "examples/journal-sveltekit",
    pkg: "@greatcms/example-journal-sveltekit",
    port: 4325,
    serve: (port) => ["exec", "vite", "dev", "--port", String(port), "--strictPort"],
  },
  {
    id: "sundial",
    name: "Sundial (Nuxt)",
    dir: "examples/changelog-nuxt",
    pkg: "@greatcms/example-changelog-nuxt",
    port: 4326,
    serve: (port) => ["exec", "nuxt", "dev", "--port", String(port)],
  },
];

// --ignore-lock: run here, on this port, even if another dev server for the site is up.
const astro = (port) => ["exec", "astro", "dev", "--port", String(port), "--ignore-lock"];

/** The first port from `start` nothing on this machine is listening on. */
async function freePort(start, taken) {
  for (let port = start; ; port++) {
    if (taken.has(port)) continue;
    // oxlint-disable-next-line no-await-in-loop -- each port is tried only if the last was busy
    const free = await new Promise((resolve) => {
      const probe = createServer()
        .once("error", () => resolve(false))
        .once("listening", () => probe.close(() => resolve(true)))
        .listen(port, "localhost");
    });
    if (free) return port;
  }
}

// Vite moves to the next port when one is busy, which would leave the studio framing whatever
// else is running there, so each site is given a port that is free before it starts.
const taken = new Set([8787]);
for (const site of sites) {
  // oxlint-disable-next-line no-await-in-loop -- a port is only free once the sites before it chose
  site.port = await freePort(site.port, taken);
  taken.add(site.port);
}

const colours = ["\x1b[32m", "\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[34m", "\x1b[31m"];
const reset = "\x1b[0m";

function run(label, command, args, env = {}, colour = colours[0]) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `${colour}${label.padEnd(9)}${reset}│ `;
  const relay = (stream) => (chunk) => {
    for (const line of String(chunk).split("\n"))
      if (line.trim()) stream.write(`${prefix}${line}\n`);
  };
  child.stdout.on("data", relay(process.stdout));
  child.stderr.on("data", relay(process.stderr));
  return child;
}

process.stdout.write("Building the packages the studio and the sites read…\n");
const build = spawnSync(
  "pnpm",
  [
    "turbo",
    "run",
    "build",
    "--filter=@greatcms/studio...",
    "--filter=@greatcms/reader...",
    "--output-logs=errors-only",
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [
  run(
    "studio",
    "pnpm",
    ["--filter", "@greatcms/studio", "dev"],
    {
      STUDIO_PASSWORD: password,
      STUDIO_SECRET: readFileSync(secretFile, "utf8").trim(),
      STUDIO_DB: join(data, "dev.sqlite"),
      STUDIO_SITES: JSON.stringify(
        sites.map((site) => ({
          id: site.id,
          name: site.name,
          path: join(root, site.dir),
          devUrl: `http://localhost:${site.port}`,
        })),
      ),
    },
    colours[0],
  ),
  ...sites.map((site, index) =>
    run(
      site.id,
      "pnpm",
      ["--filter", site.pkg, ...(site.serve ?? astro)(site.port)],
      // Forms on the site post to this studio's inbox.
      { PUBLIC_CMS_URL: "http://localhost:8787", PUBLIC_CMS_SITE_ID: site.id },
      colours[(index + 1) % colours.length],
    ),
  ),
];

setTimeout(() => {
  process.stdout.write(
    [
      "",
      "  Studio                      http://localhost:8787   password: " +
        (process.env.STUDIO_PASSWORD ? "(your STUDIO_PASSWORD)" : password),
      ...sites.map((site) => `  ${site.name.padEnd(27)} http://localhost:${site.port}`),
      "",
      "  The studio frames each site and writes your unsaved edits where its dev server reads them.",
      "  Ctrl-C stops everything.",
      "",
    ].join("\n"),
  );
}, 4000);

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

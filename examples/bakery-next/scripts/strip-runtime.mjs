/** After `next build`: takes the Next.js runtime out of pages that have no client component, or fails the build saying why it cannot. */

import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const MANIFESTS = join(ROOT, ".next/server/app");
const CHUNKS = "/_next/static/chunks/";

// The client modules Next.js puts in every App Router page; with no router running they do nothing.
const FRAMEWORK = new Set([
  "client/components/layout-router.js",
  "client/components/render-from-template-context.js",
  "client/components/client-page.js",
  "client/components/client-segment.js",
  "client/components/http-access-fallback/error-boundary.js",
  "client/components/builtin/global-error.js",
  "lib/framework/boundary-components.js",
  "lib/metadata/generate/icon-mark.js",
]);

// Every inline script a page without client components carries: the chunk list and the RSC payload.
const BOOTSTRAP = [
  /^\(globalThis\["TURBOPACK"\] \|\| \(globalThis\["TURBOPACK"\] = \[\]\)\)\.push\(\{[^;]*\}\);?$/,
  /^\(self\.__next_f=self\.__next_f\|\|\[\]\)\.push\(\[0\]\)$/,
];
const PAYLOAD = /^self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)$/;
// What only the client router fetches: the same payload, per page and per segment.
const ROUTER_DATA = /^(index|__next\..+)\.txt$/;
const DATA_TYPES = new Set(["application/ld+json", "application/json"]);

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const LINK = /<link\b[^>]*>/g;
const attribute = (tag, name) =>
  new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag)?.[1].replaceAll("&amp;", "&");

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

/** Module id to source path, from the manifests the build wrote for each route. */
function clientModules() {
  if (!existsSync(MANIFESTS)) throw new Error(`${MANIFESTS} is missing: run \`next build\` first.`);
  const sandbox = { globalThis: {} };
  for (const file of files(MANIFESTS).filter((path) =>
    path.endsWith("_client-reference-manifest.js"),
  ))
    runInNewContext(readFileSync(file, "utf8"), sandbox);
  const byId = new Map();
  for (const manifest of Object.values(sandbox.globalThis.__RSC_MANIFEST ?? {}))
    for (const [path, { id }] of Object.entries(manifest.clientModules ?? {}))
      byId.set(String(id), path);
  if (byId.size === 0) throw new Error("The build's client reference manifests list no module.");
  return byId;
}

/** The page without its runtime, or the reasons it has to keep it. */
function strip(html, modules) {
  const problems = [];
  let payload = "";
  let scripts = 0;

  const withoutScripts = html.replace(SCRIPT, (tag, attributes, body) => {
    const type = attribute(attributes, "type");
    if (type && DATA_TYPES.has(type)) return tag;
    scripts += 1;
    const src = attribute(attributes, "src");
    if (src) {
      if (src.startsWith(CHUNKS)) return "";
      problems.push(`a script from ${src}`);
      return tag;
    }
    const data = PAYLOAD.exec(body);
    if (data) payload += JSON.parse(data[1]);
    else if (!BOOTSTRAP.some((known) => known.test(body)))
      problems.push(`an inline script this step does not recognise: ${body.slice(0, 80)}`);
    return "";
  });
  if (scripts === 0) return { html, problems, scripts };

  const references = [...payload.matchAll(/^[0-9a-f]+:I(\[.*\])$/gm)];
  if (references.length === 0) problems.push("no RSC payload to read its client components from");
  for (const [, row] of references) {
    const [id, , name] = JSON.parse(row);
    const source = modules.get(String(id));
    const known = source?.replace(/^.*\/next\/dist\/(esm\/)?/, "");
    if (!source) problems.push(`a client module the build's manifests do not list (${id})`);
    else if (!FRAMEWORK.has(known)) problems.push(`a client component: ${name} from ${source}`);
  }

  const stripped = withoutScripts.replace(LINK, (tag) => {
    const rel = attribute(tag, "rel");
    if (rel !== "modulepreload" && !(rel === "preload" && attribute(tag, "as") === "script"))
      return tag;
    if (attribute(tag, "href")?.startsWith(CHUNKS)) return "";
    problems.push(`a script preload this step does not recognise: ${tag}`);
    return tag;
  });
  return { html: stripped, problems, scripts };
}

function pruneEmpty(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) pruneEmpty(join(dir, entry.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

const modules = clientModules();
const pages = files(DIST).filter((path) => path.endsWith(".html"));
const results = pages.map((path) => ({
  path,
  ...strip(readFileSync(path, "utf8"), modules),
}));

const failures = results.filter((result) => result.problems.length > 0);
if (failures.length > 0) {
  for (const { path, problems } of failures)
    console.error(
      `${relative(ROOT, path)} needs JavaScript:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  console.error(
    "\nNothing was changed. Either take the script out of the page, or keep the runtime by\n" +
      'making the build script in package.json plain "next build" (see the README).',
  );
  process.exit(1);
}

for (const { path, html } of results) writeFileSync(path, html);

const dead = files(DIST).filter(
  (path) =>
    (path.startsWith(join(DIST, "_next")) && path.endsWith(".js")) ||
    ROUTER_DATA.test(path.slice(path.lastIndexOf("/") + 1)),
);
for (const path of dead) rmSync(path);
pruneEmpty(DIST);

// Whatever a page still asks for under /_next/ has to have survived.
for (const { path, html } of results)
  for (const [, url] of html.matchAll(/\b(?:href|src)="(\/_next\/[^"?#]*)/g))
    if (!existsSync(join(DIST, url))) {
      console.error(`${relative(ROOT, path)} still refers to ${url}, which is gone.`);
      process.exit(1);
    }

const removed = results.reduce((total, { scripts }) => total + scripts, 0);
console.log(
  `strip-runtime: ${removed} scripts out of ${results.length} pages, ${dead.length} files deleted.`,
);

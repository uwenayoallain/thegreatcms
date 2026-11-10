/** Generates the agent-readable documentation surface: llms.txt, llms-full.txt, and docs.json. */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDirs = [join(root, "docs"), join(root, "apps/docs/public")];

const SITE = "https://greatcms.uwe.rw";

const PAGES = [
  {
    title: "The GreatCMS Content Standard",
    description:
      "The file format a site must contain to be managed: schema, content layout, and resolution rules. This document is the product.",
    source: "SPEC.md",
    url: "/spec",
  },
  {
    title: "GreatCMS Overview",
    description:
      "What GreatCMS is, what it deliberately does not do, and the design decisions behind it.",
    source: "README.md",
    url: "/",
    // The root page's markdown twin needs a name of its own; "/.md" is not one.
    markdownUrl: "/index.md",
  },
];

const summary = [
  "GreatCMS is a Git-backed CMS for sites that should not depend on one at runtime.",
  "It manages only the regions of a page you opt in; everything else stays hand-written code.",
  "Publishing writes files to a repository, and the commit triggers whatever deploy pipeline already existed.",
  "",
  "It is not a framework plugin. The integration surface is a schema file and some JSON: the tooling",
  "scaffolds Astro, Next.js, Nuxt and SvelteKit, and any language that reads JSON can consume it.",
  "If you are an agent wiring a site up to it, read the standard below and write files: there is no",
  "SDK to install and no runtime to call.",
].join("\n");

/** Root is "/index.md"; every other page is its own path plus ".md". */
function markdownUrlFor(page) {
  return page.markdownUrl ?? `${page.url}.md`;
}

/** The docs collection on the website, in the order the site shows it. */
async function docsPages() {
  const dir = "apps/docs/content/docs";
  const names = (await readdir(join(root, dir))).filter((name) => name.endsWith(".md")).toSorted();
  const pages = await Promise.all(
    names.map(async (name) => {
      const raw = await readFile(join(root, dir, name), "utf8");
      const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
      const front = Object.fromEntries(
        (match?.[1] ?? "").split("\n").map((line) => {
          const index = line.indexOf(":");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }),
      );
      const slug = name.replace(/\.md$/, "");
      return {
        title: front.title ?? slug,
        description: front.summary ?? "",
        order: Number(front.order ?? 50),
        source: `${dir}/${name}`,
        url: `/docs/${slug}`,
        content: `# ${front.title ?? slug}\n\n${front.summary ? `> ${front.summary}\n\n` : ""}${raw.slice(match?.[0].length ?? 0).trim()}\n`,
      };
    }),
  );
  return pages.toSorted((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

const pages = [
  ...(await Promise.all(
    PAGES.map(async (page) => {
      const content = await readFile(join(root, page.source), "utf8");
      return Object.assign({ content }, page);
    }),
  )),
  ...(await docsPages()),
];

const llms = [
  "# GreatCMS",
  "",
  `> ${summary.split("\n").join("\n> ")}`,
  "",
  "## Docs",
  "",
  ...pages.map(
    (page) =>
      `- [${page.title}](${SITE}${page.url}): ${page.description}\n  - Markdown: ${SITE}${markdownUrlFor(page)}`,
  ),
  "",
  "## Machine-readable entrypoints",
  "",
  `- [docs.json](${SITE}/docs.json)`,
  `- [llms-full.txt](${SITE}/llms-full.txt): every document above in one fetch`,
  `- [schema.schema.json](${SITE}/json-schema/schema.schema.json): JSON Schema for .cms/schema.yaml`,
  `- [config.schema.json](${SITE}/json-schema/config.schema.json): JSON Schema for .cms/config.yaml`,
  "",
  "## Agent skill",
  "",
  "The repository ships a skill that teaches an agent to add GreatCMS to a site, extend the",
  "content model, read content at build time and check it before committing:",
  "",
  "```sh",
  "npx skills add uwenayoallain/thegreatcms@greatcms",
  "```",
  "",
  "Inside a managed repository, `greatcms init` leaves a note in AGENTS.md, and",
  "`greatcms describe` prints the content model as one outline to write content against, and",
  "`greatcms check --json` / `greatcms doctor --json` give machine-readable answers.",
  "",
  "## Conformance",
  "",
  "A reader is correct if it reproduces the fixture site's resolved documents:",
  "",
  "```sh",
  "npx @greatcms/conformance fixtures        # path to the fixture site",
  "npx @greatcms/conformance verify ./out    # ./out holds <region-id>.json dumps",
  "```",
  "",
].join("\n");

const llmsFull = [
  "# GreatCMS: complete documentation",
  "",
  "This file concatenates the public docs in source order, for agents that prefer one fetch.",
  "",
  ...pages.flatMap((page) => [
    "---",
    `title: ${page.title}`,
    `source: ${page.source}`,
    `url: ${SITE}${page.url}`,
    "---",
    "",
    page.content,
    "",
  ]),
].join("\n");

const manifest = {
  name: "GreatCMS",
  url: SITE,
  description: summary.split("\n").filter(Boolean).slice(0, 3).join(" "),
  specVersion: 1,
  agentEntrypoints: {
    manifest: "/docs.json",
    llms: "/llms.txt",
    llmsFull: "/llms-full.txt",
    schemaJsonSchema: "/json-schema/schema.schema.json",
    configJsonSchema: "/json-schema/config.schema.json",
  },
  // An installable skill for agents working inside a site: commands, file shapes, pitfalls.
  agentSkill: {
    source: "https://github.com/uwenayoallain/thegreatcms/tree/main/skills/greatcms",
    install: "npx skills add uwenayoallain/thegreatcms@greatcms",
  },
  integration: {
    // The shortest possible description of what wiring up a site involves.
    steps: [
      "Add .cms/schema.yaml describing the regions you want managed.",
      "Read <regions dir>/<region-id>.json at build time, layered over the schema's defaults.",
      "A missing content file is not an error; it resolves to those defaults.",
    ],
    requiresSdk: false,
    requiresRuntime: false,
    languages: "any that can read JSON",
  },
  pages: pages.map((page) => ({
    title: page.title,
    description: page.description,
    source: page.source,
    url: page.url,
    markdownUrl: markdownUrlFor(page),
  })),
};

for (const page of pages) delete page.order;

const artifacts = [
  ["llms.txt", llms],
  ["llms-full.txt", llmsFull],
  ["docs.json", `${JSON.stringify(manifest, null, 2)}\n`],
];

const check = process.argv.includes("--check");
await Promise.all(outDirs.map((dir) => mkdir(dir, { recursive: true })));

const targets = outDirs.flatMap((dir) =>
  artifacts.map(([name, content]) => [join(dir, name), content]),
);

const results = await Promise.all(
  targets.map(async ([path, content]) => {
    if (!check) {
      await writeFile(path, content);
      process.stdout.write(`wrote ${relative(root, path)}\n`);
      return true;
    }
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing === content) return true;
    process.stderr.write(
      `${relative(root, path)} is out of date.\n  fix: run \`pnpm run docs:build\`\n`,
    );
    return false;
  }),
);

if (check && results.includes(false)) process.exit(1);
if (check) process.stdout.write("agent docs are up to date\n");

/** `greatcms init` — scaffold a site's CMS configuration. */

import { parseSchema, SPEC_VERSION } from "@greatcms/spec";
import type { Framework } from "./detect.js";

export type TemplateId = "hero" | "landing" | "blog" | "blank";

export interface Template {
  id: TemplateId;
  label: string;
  hint: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "hero",
    label: "One managed region",
    hint: "a hero section — the rest of the page stays code",
  },
  {
    id: "landing",
    label: "Landing page",
    hint: "hero plus a reorderable block list of features, text, and CTAs",
  },
  {
    id: "blog",
    label: "Blog",
    hint: "a Markdown collection with a managed intro region",
  },
  { id: "blank", label: "Blank", hint: "config only — you write the regions" },
];

export interface InitAnswers {
  name: string;
  framework: Framework;
  template: TemplateId;
  regionsDir: string;
  mediaDir: string;
  mediaUrlPrefix: string;
  collectionsDir: string;
  branch: string;
  /** Relative path from .cms/ to the published JSON Schema, when resolvable. */
  schemaUrl: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface InitPlan {
  files: GeneratedFile[];
  /** The region a person should look at first, used in the next-steps snippet. */
  firstRegion: string | null;
}

export const DEFAULT_SCHEMA_URL = "https://unpkg.com/@greatcms/spec/json-schema/schema.schema.json";
export const DEFAULT_CONFIG_SCHEMA_URL =
  "https://unpkg.com/@greatcms/spec/json-schema/config.schema.json";

export function planInit(answers: InitAnswers): InitPlan {
  const schema = renderSchema(answers);
  const config = renderConfig(answers);

  // Generating something our own parser rejects would be an embarrassing way to start someone's.
  parseSchema(schema, { file: ".cms/schema.yaml" });

  return {
    files: [
      { path: ".cms/schema.yaml", content: schema },
      { path: ".cms/config.yaml", content: config },
    ],
    firstRegion: answers.template === "blank" ? null : "home.hero",
  };
}

function renderConfig(answers: InitAnswers): string {
  return `# yaml-language-server: $schema=${DEFAULT_CONFIG_SCHEMA_URL}
#
# Where content lives in this repository, and what happens when you publish.

version: ${SPEC_VERSION}

content:
  # Chosen for ${answers.framework.label}: files here are read at build time.
  regions: ${answers.regionsDir}
  media: ${answers.mediaDir}

# The URL your site serves committed media from.
mediaUrlPrefix: ${answers.mediaUrlPrefix}

publish:
  branch: ${answers.branch}
  draftBranchPrefix: cms/draft
  commitMessage: "content: update {summary}"
  # Uncomment if your pipeline needs an explicit nudge rather than a push:
  # dispatchEvent: greatcms-publish

preview:
  # {branch} is substituted. Point this at your CI's preview URLs to see drafts
  # inline in the studio. Or preview locally: greatcms preview --run "npm run dev"
  # urlTemplate: "https://{branch}--your-site.pages.dev"
`;
}

function renderSchema(answers: InitAnswers): string {
  const header = `# yaml-language-server: $schema=${answers.schemaUrl}
#
# What ${answers.name} lets the CMS manage. Everything not listed here is
# ordinary code that the studio never sees or touches.
#
# Docs: https://github.com/greatcms/greatcms/blob/main/SPEC.md

version: ${SPEC_VERSION}

site:
  name: ${quote(answers.name)}
`;

  switch (answers.template) {
    case "hero":
      return `${header}${HERO_REGIONS}`;
    case "landing":
      return `${header}${LANDING_BLOCKS}${LANDING_REGIONS}`;
    case "blog":
      return `${header}${HERO_REGIONS}${blogCollection(answers.collectionsDir)}`;
    case "blank":
      return `${header}
regions:
  # A region is any slice of a page you want to be editable. The id doubles as
  # the file name, so "home.hero" is stored at <regions dir>/home.hero.json.
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true, max: 80 }
    # Defaults render before anyone has edited anything, so the site builds
    # correctly from the moment you add this file.
    default:
      heading: ${quote(answers.name)}
`;
  }
}

const HERO_REGIONS = `
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true, max: 80 }
      subtitle: { type: text, max: 160 }
      image: { type: image }
      cta: { type: link }
    # Rendered until someone edits it, so the site is never blank.
    default:
      heading: Welcome
      subtitle: Edit this in the studio — the rest of the page stays code.
`;

const LANDING_BLOCKS = `
blocks:
  feature:
    label: Feature
    fields:
      title: { type: text, required: true, max: 60 }
      body: { type: text, multiline: true, required: true }
      icon: { type: select, options: [spark, shield, bolt], default: spark }

  text:
    label: Text
    fields:
      body: { type: richtext, required: true }

  cta:
    label: Call to action
    fields:
      label: { type: text, required: true, max: 40 }
      link: { type: link, required: true }
      style: { type: select, options: [primary, secondary], default: primary }
`;

const LANDING_REGIONS = `${HERO_REGIONS}
  home.body:
    label: Home sections
    # A blocks region is an ordered list an editor can add to and reorder.
    type: blocks
    allow: [feature, text, cta]
    max: 12
`;

function blogCollection(dir: string): string {
  return `
collections:
  blog:
    label: Blog
    path: ${dir}
    # Markdown with frontmatter, which is what every static site generator
    # already expects — no special pipeline needed.
    format: markdown
    body: content
    slug: title
    fields:
      title: { type: text, required: true, max: 120 }
      description: { type: text, max: 200 }
      date: { type: date, required: true }
      draft: { type: boolean, default: false }
      content: { type: richtext }
`;
}

/** Next steps, written so they can be followed without opening the docs. */
export function nextSteps(answers: InitAnswers, plan: InitPlan): string {
  const lines = ["", "Created:", ...plan.files.map((file) => `  ${file.path}`), ""];

  if (plan.firstRegion) {
    lines.push(
      `Read the managed region in your ${answers.framework.label} templates:`,
      "",
      indent(answers.framework.snippet(plan.firstRegion, answers.regionsDir)),
      "",
    );
  }

  if (["astro", "nuxt", "sveltekit"].includes(answers.framework.id)) {
    lines.push(
      "Add the dev-time watcher, so editing content reloads your dev server:",
      "",
      indent(
        [
          `// ${answers.framework.id === "astro" ? "astro.config.mjs" : "vite config"}`,
          'import { greatcmsWatch } from "@greatcms/reader/vite";',
          "",
          "vite: { plugins: [greatcmsWatch()] }",
        ].join("\n"),
      ),
      "",
      "Without it the files change and the page does not, because the reader uses",
      "the filesystem and Vite has no way to know.",
      "",
    );
  }

  lines.push(
    "Then:",
    "  1. Commit .cms/ — the schema is part of your site, and reviewable in PRs.",
    "  2. Connect this repository in the studio with a token that has contents: write.",
    "  3. Edit, publish, and your existing deploy pipeline does the rest.",
    "",
    "To manage another part of the page, do not hand-edit the schema:",
    "",
    indent(
      [
        "greatcms add region about.intro --field heading:text! --field body:richtext",
        "greatcms add block card --field title:text! --field body:text",
        "greatcms add collection blog --field title:text! --field content:richtext",
      ].join("\n"),
    ),
    "",
    "  greatcms check     confirm the content still matches the schema",
    "  greatcms doctor    check this setup any time",
    "",
  );

  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

/** Quotes only when YAML would otherwise misread the value. */
function quote(value: string): string {
  return /^[\w][\w \-.]*$/.test(value) ? value : JSON.stringify(value);
}

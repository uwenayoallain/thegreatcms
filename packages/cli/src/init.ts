/** `greatcms init` — scaffold a site's CMS configuration. */

import { parseSchema, SPEC_VERSION } from "@greatcms/spec";
import { quote } from "./add.js";
import type { Framework } from "./detect.js";

export type TemplateId = "hero" | "landing" | "business" | "blog" | "blank";

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
    id: "business",
    label: "Business website",
    hint: "company details, contact info, products, and flexible page sections",
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
  /** What a coding agent working in this repository needs to know, for its AGENTS.md. */
  agentsNote: string;
}

export const AGENTS_START = "<!-- greatcms:start -->";
export const AGENTS_END = "<!-- greatcms:end -->";

/** Merges the note into an AGENTS.md, replacing an earlier one between the markers. */
export function mergeAgentsNote(existing: string | null, note: string): string {
  const block = `${AGENTS_START}\n${note.trim()}\n${AGENTS_END}\n`;
  if (!existing) return `# Working in this repository\n\n${block}`;
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + AGENTS_END.length).replace(/^\n/, "")}`;
  }
  return `${existing.replace(/\s*$/, "")}\n\n${block}`;
}

function renderAgentsNote(answers: InitAnswers): string {
  return `## Content managed by GreatCMS

Some of this site's content is edited through GreatCMS and stored as files in
this repository. The rules, in order of how often they are needed:

- \`.cms/schema.yaml\` says what is editable: regions (one JSON document each),
  blocks (reorderable sections) and collections (one file per entry). Change
  the content model there, never by hand-shaping JSON. Then run
  \`npx greatcms check\` and \`npx greatcms types\` (if a types file exists).
- Region content lives in \`${answers.regionsDir}/<region-id>.json\`; a missing
  file is normal and resolves to the schema's defaults. Collections live under
  \`${answers.collectionsDir}/<collection>/<slug>.<ext>\`. Uploaded images go in
  \`${answers.mediaDir}\` and are referenced as \`${answers.mediaUrlPrefix}/<file>\`.
- Pages read content at build time with \`@greatcms/reader\` (or any reader of
  the standard). Nothing calls a CMS at runtime, and nothing should.
- Every image needs alt text unless its field says \`alt: decorative-allowed\`.
- \`npx greatcms check --json\` validates all content against the schema and is
  the thing to run before committing content changes. \`npx greatcms doctor
  --json\` shows what exists, what is still at defaults, and unsaved drafts.
- Do not edit \`.cms/draft/\`: it is the studio's unsaved-edit scratch space.

Standard: https://greatcms.dev/spec.md · Agent index: https://greatcms.dev/llms.txt
`;
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
    agentsNote: renderAgentsNote(answers),
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
  # The studio commits on whatever branch is checked out; pushing it is your deploy.
  commitMessage: "content: update {summary}"
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
    case "business":
      return `${header}${businessBlocks()}${businessRegions(answers.name)}${businessCollections(answers.collectionsDir)}`;
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

/** The recurring content shape in a real small-business website. */
function businessBlocks(): string {
  return `
blocks:
  feature:
    label: Feature
    fields:
      title: { type: text, required: true, max: 60 }
      description: { type: text, multiline: true, required: true, max: 240 }
      icon: { type: text, description: "A name your site's icon component understands" }

  feature-grid:
    label: Feature grid
    fields:
      heading: { type: text, required: true, max: 80 }
      introduction: { type: text, multiline: true, max: 240 }
      items: { type: blocks, allow: [feature], min: 1, max: 6 }

  stat:
    label: Statistic
    fields:
      value: { type: text, required: true, max: 20 }
      label: { type: text, required: true, max: 60 }
      detail: { type: text, max: 120 }

  stats:
    label: Statistics
    fields:
      heading: { type: text, max: 80 }
      items: { type: blocks, allow: [stat], min: 1, max: 6 }

  step:
    label: Process step
    fields:
      title: { type: text, required: true, max: 80 }
      description: { type: text, multiline: true, required: true, max: 240 }
      icon: { type: text, description: "A name your site's icon component understands" }

  process:
    label: Process
    fields:
      eyebrow: { type: text, max: 40 }
      heading: { type: text, required: true, max: 80 }
      introduction: { type: text, multiline: true, max: 240 }
      steps: { type: blocks, allow: [step], min: 2, max: 8 }

  story:
    label: Story
    fields:
      eyebrow: { type: text, max: 40 }
      heading: { type: text, required: true, max: 80 }
      body: { type: richtext, required: true }
      image: { type: image }
      link: { type: link }
      imageSide: { type: select, options: [start, end], default: end }

  products:
    label: Product showcase
    fields:
      heading: { type: text, required: true, max: 80 }
      introduction: { type: text, multiline: true, max: 240 }
      link: { type: link, description: "Usually points to the products page" }

  faq:
    label: Question and answer
    fields:
      question: { type: text, required: true, max: 120 }
      answer: { type: richtext, required: true }

  faq-list:
    label: Frequently asked questions
    fields:
      heading: { type: text, required: true, max: 80 }
      items: { type: blocks, allow: [faq], min: 1, max: 10 }

  cta:
    label: Call to action
    fields:
      heading: { type: text, required: true, max: 80 }
      body: { type: text, multiline: true, max: 200 }
      primary: { type: link, required: true }
      secondary: { type: link }
`;
}

function businessRegions(name: string): string {
  return `
regions:
  site.identity:
    label: Company details
    fields:
      name: { type: text, required: true, max: 80 }
      legalName: { type: text, max: 120 }
      tagline: { type: text, max: 120 }
      description: { type: text, multiline: true, max: 320 }
      founded: { type: number, integer: true, min: 1000, max: 9999 }
      registrationNumber: { type: text, max: 80 }
      logo: { type: image }
      owner:
        type: group
        label: Owner or contact person
        fields:
          name: { type: text, required: true, max: 100 }
          role: { type: text, max: 80 }
          phone: { type: text, max: 40 }
          bio: { type: text, multiline: true, max: 320 }
          photo: { type: image }
    default:
      name: ${quote(name)}
      tagline: What your business does, in one clear line

  site.contact:
    label: Contact details
    fields:
      email: { type: text, required: true }
      phone: { type: text, required: true }
      whatsapp: { type: text }
      address: { type: text, multiline: true }
      hours: { type: text, multiline: true }
      facebook: { type: link }
      instagram: { type: link }
      linkedin: { type: link }
    default:
      email: hello@example.com
      phone: "+250 000 000 000"

  site.seo:
    label: Search and sharing
    fields:
      titleTemplate: { type: text, required: true, max: 100 }
      defaultDescription: { type: text, multiline: true, required: true, max: 180 }
      siteUrl: { type: text }
      locale: { type: text, default: en }
      shareImage: { type: image }
    default:
      titleTemplate: ${quote(`%s — ${name}`)}
      defaultDescription: ${quote(`Learn more about ${name}.`)}
      locale: en

  home.hero:
    label: Home hero
    fields:
      eyebrow: { type: text, max: 40 }
      heading: { type: text, required: true, max: 80 }
      description: { type: text, multiline: true, required: true, max: 240 }
      image: { type: image }
      primary: { type: link, required: true }
      secondary: { type: link }
    default:
      heading: ${quote(name)}
      description: Tell customers what you make and why it matters.
      primary: { href: /contact, label: Contact us }

  home.sections:
    label: Home page sections
    # Add, remove, and reorder complete sections without changing a component.
    type: blocks
    allow: [feature-grid, process, stats, story, products, faq-list, cta]
    max: 12
`;
}

function businessCollections(dir: string): string {
  const parent = dir.replace(/\/+$/, "").replace(/\/blog$/, "");
  return `
collections:
  products:
    label: Products
    entryLabel: product
    path: ${parent}/products
    format: json
    slug: name
    fields:
      name: { type: text, label: Product name, required: true, max: 100 }
      category: { type: text, max: 60 }
      description: { type: text, multiline: true, required: true, max: 400 }
      image: { type: image }
      details: { type: list, label: Specifications, description: Practical facts such as size or shelf life, of: { type: text, max: 140 }, max: 12 }
      benefits: { type: list, label: Benefits, description: Short customer-facing reasons this may fit, of: { type: text, max: 140 }, max: 12 }
      packaging: { type: text, max: 160 }
      featured: { type: boolean, label: Feature on the home page, default: false }
      enquiry: { type: link, label: Enquiry action }

  pages:
    label: Pages
    entryLabel: page
    path: ${parent}/pages
    format: json
    slug: title
    fields:
      title: { type: text, label: Page name, description: Used to create the file name and URL on first publish, required: true, max: 100 }
      kind: { type: select, label: Page type, options: [standard, legal], default: standard }
      eyebrow: { type: text, max: 40 }
      heading: { type: text, label: Main heading, required: true, max: 100 }
      summary: { type: text, label: Introduction, multiline: true, max: 320 }
      image: { type: image }
      primary: { type: link, label: Primary action }
      secondary: { type: link, label: Secondary action }
      sections: { type: blocks, label: Page sections, description: Add designed sections to a standard page, allow: [feature-grid, process, stats, story, products, faq-list, cta], max: 12 }
      body: { type: richtext, label: Long-form body, description: Useful for policies and other prose-heavy pages }
      showInNavigation: { type: boolean, label: Add to main navigation, default: false }
      navigationLabel: { type: text, label: Menu label, description: Leave empty to use the page name, max: 40 }
      navigationOrder: { type: number, label: Menu order, description: Lower numbers appear first, integer: true, min: 0 }
      seoTitle: { type: text, label: Search title, description: Leave empty to use the page name, max: 100 }
      seoDescription: { type: text, label: Search description, multiline: true, max: 180 }
`;
}

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
  const addSection =
    answers.template === "business"
      ? "greatcms add section testimonial --to home.sections --field quote:richtext! --field name:text!"
      : "greatcms add block card --field title:text! --field body:text";

  if (plan.firstRegion) {
    lines.push(
      "Install the build-time reader:",
      "",
      "  npm install --save-dev @greatcms/reader",
      "",
      `Read the managed region in your ${answers.framework.label} templates:`,
      "",
      indent(answers.framework.snippet(plan.firstRegion, answers.regionsDir)),
      "",
    );
  }

  if (answers.template === "business") {
    lines.push(
      "The shared details, flexible sections, products, and pages use the same reader:",
      "",
      indent(
        [
          'import { createReader } from "@greatcms/reader";',
          "const cms = createReader();",
          'const company = cms.region("site.identity");',
          'const sections = cms.blocks("home.sections");',
          'const products = cms.collection("products");',
          'const pages = cms.collection("pages");',
        ].join("\n"),
      ),
      "",
      "Render the pages collection through one dynamic route. Adding an entry in",
      "the studio can then add an About, Services, or legal page without another schema edit.",
      "The business example in GreatCMS shows this complete route.",
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
    "  2. Connect this folder in the studio, and give it your dev server's URL.",
    "  3. Edit, publish, and your existing deploy pipeline does the rest.",
    "",
    "To manage another part of the page, do not hand-edit the schema:",
    "",
    indent(
      [
        "greatcms add region about.intro --field heading:text! --field body:richtext",
        addSection,
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

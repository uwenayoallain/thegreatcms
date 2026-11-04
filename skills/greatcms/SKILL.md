---
name: greatcms
description: Add GreatCMS to a site, extend its content model, read managed content at build time, and check it before committing. Use when a task mentions GreatCMS, .cms/schema.yaml, a Git-backed or file-based CMS, or making part of a static site editable without a runtime CMS.
---

# GreatCMS

GreatCMS is a file standard, not a service. A site is managed when it contains
`.cms/schema.yaml` (what is editable) and content files the site reads at build
time. There is no API to call, no SDK to initialise, and nothing to run in
production. The studio, where people edit, writes commits to the repository;
your job as an agent is the files.

Everything below is copy-paste safe and tested. Prefer the CLI to hand-writing
YAML: it keeps indentation, field syntax and paths right.

## Add it to a site

```sh
npx greatcms init --yes            # detects Astro, Next.js, Nuxt, SvelteKit
npx greatcms doctor                # prints what it set up and where content lives
npx greatcms describe              # every field, its type and limits, and the file it lives in: read before writing content
```

`init` writes `.cms/schema.yaml`, `.cms/config.yaml` and a note in `AGENTS.md`
for the next agent. It also adds `@greatcms/reader` to `package.json` and the
live-preview line to the framework's config (see below); run the package
manager's install afterwards. Flags for an unattended run: `--framework astro|next|nuxt|sveltekit|eleventy|generic`,
`--template hero|landing|business|blog|blank`, `--name "<site>"`, `--dir <content dir>`,
`--no-wire` to leave `package.json` and framework config alone.

Expected tail of the output:

```
Setting up GreatCMS in /path/to/site
...
Wrote .cms/schema.yaml and .cms/config.yaml
```

## Extend the content model

```sh
npx greatcms add region footer --field tagline:text --field email:text!
npx greatcms add section testimonial --to home.sections --field quote:richtext! --field name:text!
npx greatcms add collection posts --format markdown --field title:text! --field date:date! --field body:richtext!
npx greatcms types --out src/cms.d.ts   # TypeScript for every region, block and collection
```

Field types: `text richtext image link number boolean date file`, `select(a|b)`,
`list(text)`. A trailing `!` means required. These commands edit the existing
schema as text and keep its comments; do not rewrite the file wholesale.

Three schema keys the commands do not write, added by hand when needed:

```yaml
author: { type: reference, collection: people } # an entry's slug; `multiple: true` for a list
slides: { type: blocks, allow: [slide], when: { field: style, equals: carousel } } # shown only then
cta: # a block with looks the editor picks
  variants: [{ value: dark, label: Dark panel }, { value: light, label: Light panel }]
  fields: { heading: { type: text, required: true } }
```

A block with `variants` always resolves with `_variant` set (the first unless
the content names another), so a component branches on `block._variant`.
Run `greatcms types` again after any schema change.

## Read content in a page

Astro (the reader is synchronous and build-time only):

```ts
import { createCms } from "@greatcms/reader";
const cms = createCms({ root: new URL("..", import.meta.url).pathname });

const hero = cms.region("home.hero"); // schema defaults layered under the file
const posts = cms.collection("posts"); // [{ slug, data }]
```

Pages built from a collection must read the entry inside the page, not pass it
from `getStaticPaths()`; the dev server caches those props and the studio's
live preview would never show an edit:

```astro
---
export function getStaticPaths() {
  return cms.collection("posts").map((post) => ({ params: { slug: post.slug } }));
}
const post = cms.collection("posts").find((entry) => entry.slug === Astro.params.slug);
if (!post) return Astro.redirect("/404");
---
```

Any other language reads the same files: `<regions dir>/<region-id>.json` over
the schema's `default:` values. A missing file is not an error. The rules are
in https://greatcms.uwe.rw/spec.md (section 6 is the part that matters).

## Edit content as files

Region: `content/cms/<region-id>.json` with the field values and a `_meta`
object (`updatedAt`, `updatedBy`, `version`). Blocks regions hold
`{"blocks": [{"_type": "<block>", ...fields}]}`. Collection entries are
Markdown with front matter, MDX, or JSON, named by slug.

Images: `{"src": "<mediaUrlPrefix>/<file>", "alt": "...", "width": 1200, "height": 800}`.
`alt` is required unless the field says `alt: decorative-allowed`.

Then check before committing:

```sh
npx greatcms check --json     # exit 0 and {"ok":true,...} when every file matches the schema
```

It also reports missing images, internal links to entries that do not exist,
and references to missing entries as errors; unused media, links without text
and skipped heading levels come back as `warnings`, which do not fail the run.
A failure names the file, the field and the fix, for example:

```
content/cms/home.hero.json: heading is required
  fix: add "heading" or remove the file to fall back to the schema default
```

## Preview and publish

- The live preview is one dev-only line per framework, which `init` adds when
  the config is a shape it recognises and prints otherwise:
  Astro `integrations: [greatcms()]` (`@greatcms/reader/astro`);
  Next.js `<GreatcmsPreview />` in the root layout's `<head>` (`@greatcms/reader/next`);
  Nuxt `modules: ["@greatcms/reader/nuxt"]`;
  SvelteKit `greatcmsWatch()` in `vite.config` plus `export { greatcmsHandle as handle }`
  in `src/hooks.server` (`@greatcms/reader/sveltekit`);
  any other Vite site `plugins: [greatcmsWatch()]` (`@greatcms/reader/vite`).
- The studio frames the site's own dev server. Tell it where entries are seen
  with `preview.paths` in `.cms/config.yaml`:
  ```yaml
  preview:
    paths:
      pages: { home: "/", "*": "/{slug}" }
      posts: "/blog/{slug}"
  ```
- Vite refuses unknown hosts: when the dev server is reached by a public name,
  pass it as `PREVIEW_HOST` and set `vite.server.allowedHosts: [process.env.PREVIEW_HOST]`.
- Never write into `.cms/draft/`; it is the studio's unsaved edits.
- Publishing is one commit of content and the media it references. Hosting on
  one server: https://greatcms.uwe.rw/docs/self-hosting.md

## Invariants you must not break

- The site never depends on the studio at runtime: no fetch, no key, no DB.
- Public sites ship zero JavaScript from GreatCMS; the reader is build-time.
- A region id is a file name. Renaming a region orphans its content file.
- Changing how existing content resolves is a spec version bump, not a tweak.

## Where to read more

- Index for agents: https://greatcms.uwe.rw/llms.txt
- Every doc in one fetch: https://greatcms.uwe.rw/llms-full.txt
- JSON Schema for `.cms/schema.yaml`: https://greatcms.uwe.rw/json-schema/schema.schema.json
- JSON Schema for `.cms/config.yaml`: https://greatcms.uwe.rw/json-schema/config.schema.json

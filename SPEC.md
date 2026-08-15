# The GreatCMS Content Standard — version 1

This document is the product. Everything else in this repository is an
implementation of it.

A site is managed by GreatCMS if it contains a schema file and reads content
from the paths described here. That is the entire integration surface. No
plugin, no SDK, no runtime dependency, no build hook. If you can read JSON and
YAML, you can consume a GreatCMS site — and if you can read only JSON, you can
still consume one, because the schema may be written as JSON too.

Reading this document should be enough to write a consumer in any language in
under half an hour. If it is not, that is a bug in this document.

---

## 1. Repository layout

```
your-site/
├── .cms/
│   ├── schema.yaml       # or schema.json — the content model
│   └── config.yaml       # or config.json — paths and publishing (optional)
├── content/
│   ├── cms/              # structured regions, written by the studio
│   │   ├── home.hero.json
│   │   └── home.body.json
│   └── blog/             # collection entries
│       └── my-post.md
└── public/media/         # uploads, committed alongside content
```

Directories are configurable in `.cms/config.yaml`; the ones above are defaults.
Nothing else in the repository is touched by the CMS, ever.

---

## 2. Concepts

**Region** — a named slice of a page under CMS control: `home.hero`,
`pricing.faq`. Everything not declared a region is ordinary code the CMS never
sees. This is the hybrid model: a page can have one managed region, or be
entirely managed, and both are the same mechanism.

**Block** — a reusable field set. A _blocks region_ holds an ordered list of
blocks the editor can add, remove, and reorder.

**Collection** — a folder of entries with a shared shape: a blog, case studies,
changelog. Entries are Markdown with YAML frontmatter by default.

---

## 3. `.cms/schema.yaml`

```yaml
version: 1

site:
  name: My Site # optional, shown in the studio

blocks: # optional
  hero:
    label: Hero
    fields:
      heading: { type: text, required: true, max: 80 }
      image: { type: image }

regions: # at least one region or collection is required
  home.hero: # ← the region id
    label: Home hero
    fields:
      heading: { type: text, required: true, max: 80 }
      subtitle: { type: text, default: Welcome }
    default: # region-level defaults beat field-level defaults
      heading: Hello

  home.body:
    type: blocks
    allow: [hero]
    min: 0
    max: 8

collections: # optional
  blog:
    path: content/blog
    format: markdown # markdown | mdx | json
    body: content # which field becomes the prose body
    slug: title # which field derives the file name
    fields:
      title: { type: text, required: true }
      date: { type: date, required: true }
      content: { type: richtext }
```

**Region ids** match `^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$`. They are
used verbatim as file names, so this is enforced, not advisory.

**Block and collection names** match `^[a-z0-9][a-z0-9_-]*$`.

**Collection formats** decide the file extension and how an entry is stored:

| `format`   | Extension | Stored as                          |
| ---------- | --------- | ---------------------------------- |
| `markdown` | `.md`     | YAML frontmatter over a prose body |
| `mdx`      | `.mdx`    | YAML frontmatter over an MDX body  |
| `json`     | `.json`   | one JSON object, no body           |

`mdx` is `markdown` with a different extension, and the difference matters at
both ends: a build treats `.mdx` as MDX rather than Markdown, and an editor must
treat the body as **source rather than formatted prose**. An MDX body contains
JSX, which is not HTML; parsing it into a rich-text editor and serializing it
back would silently delete the components in it. A conforming editor edits an
MDX body as text.

A JSON Schema for this file ships at `@greatcms/spec/json-schema`, giving
autocomplete and inline validation in any editor that supports it.

---

## 4. Field types

Every field accepts `label`, `description`, and `required`.

| Type       | Extra keys                                      | Stored value                                            |
| ---------- | ----------------------------------------------- | ------------------------------------------------------- |
| `text`     | `min`, `max`, `pattern`, `multiline`, `default` | string                                                  |
| `richtext` | `allow`, `default`                              | `{ "html": "…", "_ast": … }`                            |
| `number`   | `min`, `max`, `step`, `integer`, `default`      | number                                                  |
| `boolean`  | `default`                                       | boolean                                                 |
| `select`   | `options`, `multiple`, `default`                | string, or array if `multiple`                          |
| `date`     | `time`, `default`                               | ISO 8601 string                                         |
| `link`     | `default`                                       | `{ "href": "…", "label"?: "…", "external"?: bool }`     |
| `image`    | `alt`, `accept`, `default`                      | `{ "src": "…", "alt": "…", "width"?: n, "height"?: n }` |
| `file`     | `accept`, `default`                             | `{ "src": "…", "name"?: "…", "size"?: n }`              |
| `list`     | `of`, `min`, `max`                              | array of the `of` type                                  |
| `group`    | `fields`                                        | nested object                                           |
| `blocks`   | `allow`, `min`, `max`, `default`                | array of block objects, each with `_type`               |

`options` for `select` is either `[a, b]` or `[{ value: a, label: A }]`.

### Nested blocks

A `blocks` field holds the same shape a blocks region does — an ordered array
whose entries each carry a `_type` naming a block defined at the top level:

```yaml
blocks:
  card:
    fields:
      title: { type: text, required: true }
  grid:
    label: Card grid
    fields:
      heading: { type: text }
      cards: { type: blocks, allow: [card], min: 1, max: 4 }
```

```json
{
  "_type": "grid",
  "heading": "What you get",
  "cards": [{ "_type": "card", "title": "Content lives in Git" }]
}
```

This is what lets a managed section hold a composed component — a card grid, a
tabbed panel, a set of columns — instead of only flat fields. Nesting is
unbounded: a block reachable through `allow` may itself have a `blocks` field.
A schema that nests a block inside itself is legal, and a consumer is expected
to stop at the depth the content actually has, not to pre-expand the schema.

### Rich text

Rich text is stored as **sanitized HTML** in `html`, so a consumer can print it
with no library at all. The editor's structured document is preserved in `_ast`
for lossless round-tripping. **Consumers should ignore `_ast`.** Any key
beginning with `_` is machinery and may be ignored by consumers.

### Images and accessibility

Uploads are committed alongside content, into `content.media`, and served from
`mediaUrlPrefix`. Names are content-addressed so identical bytes reuse a path
and edited bytes get a new one.

`alt` is required by default. A field may set `alt: decorative-allowed`, which
is the only way an empty `alt` validates — making an inaccessible image a
deliberate choice rather than an oversight. `width` and `height` are recorded on
upload so consumers can prevent layout shift.

---

## 5. Content files

### Single region → `<regions dir>/<region-id>.json`

```json
{
  "heading": "Publish from anywhere",
  "subtitle": "Content in Git, deploys on commit.",
  "_meta": { "updatedAt": "2026-08-12T18:00:00.000Z", "updatedBy": "ada", "version": 1 }
}
```

### Blocks region → same path, `blocks` array

```json
{
  "blocks": [
    { "_type": "hero", "heading": "Hybrid by default" },
    { "_type": "cta", "label": "Read the spec", "link": { "href": "/spec" } }
  ]
}
```

Each block carries `_type`, naming a block defined in the schema.

### Collection entry → `<collection path>/<slug>.<ext>`

```markdown
---
title: Publish from anywhere
date: 2026-08-12
tags: [release, git]
---

Body text becomes the field named by the collection's `body` key.
```

An `mdx` entry is the same file with an `.mdx` extension, and a body that may
import and use components:

```mdx
---
title: Latency after the migration
date: 2026-08-12
---

import Chart from "../../components/Chart.astro";

<Chart data={[1, 2, 3]} caption="p99 latency" />

The prose around the component is ordinary Markdown.
```

The standard stores that body verbatim. It does not parse the JSX, resolve the
imports, or care whether the components exist — that is the site's build, and
it is deliberately none of the CMS's business.

Files are written with two-space JSON indentation, keys sorted alphabetically
with `_`-prefixed keys last, and a trailing newline — so diffs stay readable and
two tools writing the same content produce the same bytes.

---

## 6. Resolution rules (the important part)

A consumer resolves a region in three steps. Getting these right is what the
conformance kit checks.

1. **Start from defaults.** Collect `default` from each field. For a blocks
   region, the default is the region's `default` array, or `[]`.
2. **Apply the region's `default` object**, which overrides field-level defaults.
3. **Layer the stored file on top**, if it exists.

Merge rules:

- Objects merge **deeply**, key by key.
- Arrays are **replaced wholesale** — merging lists item-by-item produces
  results no author would predict.
- Within a blocks region, each stored block is merged over its block's field
  defaults, so a field added to a block later still renders.
- **A missing content file is not an error.** The region resolves to its
  defaults, so a site builds correctly before the CMS has ever run.
- **A missing schema file _is_ an error.** Defaults live in the schema, so a
  consumer that cannot find it should fail loudly rather than quietly render
  empty regions. The schema is part of the site, committed alongside the code —
  what a site never depends on is the _studio_: no network call, no database, no
  API key, and no running service at build or request time. Shut the studio down
  permanently and every site it managed keeps building from what is in Git.
- A stored key the schema does not define is left alone by consumers. Only the
  studio treats unknown keys as an error, so a rename surfaces during editing
  rather than silently dropping content.

---

## 7. `.cms/config.yaml`

Optional; these are the defaults.

```yaml
version: 1
content:
  regions: content/cms
  media: public/media
mediaUrlPrefix: /media
publish:
  branch: main
  draftBranchPrefix: cms/draft
  commitMessage: "content: update {summary}"
  dispatchEvent: null # optional repository_dispatch after publish
preview:
  urlTemplate: null # e.g. https://{branch}--site.pages.dev
```

Paths must be repository-relative and may not contain `..`.

---

## 8. Publishing

The studio writes content with the GitHub Git Data API as a **single atomic
commit** per publish — blob, tree, commit, ref update — so a region and its
images land together or not at all. The commit is the deploy trigger; whatever
CI the repository already had does the rest. `publish.dispatchEvent` fires a
`repository_dispatch` for pipelines that need an explicit nudge.

Consumers are unaffected by all of this. They read files.

---

## 8a. Form submissions

Git cannot hold a message someone typed on your site, so the studio accepts one
directly:

```html
<form method="POST" action="https://studio.example.com/f/{siteId}/contact">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required />

  <input type="hidden" name="_redirect" value="/thanks/" />
  <input type="hidden" name="_t" value="1755024000000" />

  <div class="trap" aria-hidden="true">
    <label for="company">Company</label>
    <input id="company" name="company" tabindex="-1" autocomplete="off" />
  </div>

  <button>Send</button>
</form>
```

Reserved names, stripped before storage:

| Field       | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `_redirect` | Where to send the visitor afterwards. Same-site paths only. |
| `_t`        | When the form was rendered, in epoch milliseconds.          |
| `company`   | Honeypot. Hide it visually _and_ from assistive technology. |

Everything else is stored as the submission. Spam is scored from the honeypot,
the time between render and submit, and link density — never a CAPTCHA, which
taxes every legitimate visitor to inconvenience a bot that solves them anyway.
Suspected spam is kept, not discarded, so nothing is lost silently.

---

## 9. Conformance

```bash
npx @greatcms/conformance fixtures        # path to the fixture site
npx @greatcms/conformance verify ./out    # ./out holds <region-id>.json dumps
```

Point your reader at the fixture site, dump each resolved region as
`<region-id>.json` into a directory, and run `verify`. The fixture deliberately
includes a region with no content file, a region edited before a field was
added, a blocks region with a block missing a defaulted field, and a decorative
image with empty alt text — the four cases naive implementations get wrong.

A reference reader in Python (stdlib + PyYAML, ~120 lines) lives at
`examples/reader-python/read.py` and passes the suite. It is the shortest honest
answer to "how hard is this to integrate?".

---

## 10. Versioning

`version: 1` in both files. A consumer that sees a higher major version it does
not recognize should refuse rather than guess. New field types and optional keys
may be added within version 1; anything that changes how existing content
resolves requires a version bump and a documented migration.

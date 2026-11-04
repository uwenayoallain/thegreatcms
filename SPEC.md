# The GreatCMS Content Standard: version 1

This document is the product. Everything else in this repository is an
implementation of it.

A site is managed by GreatCMS if it contains a schema file and reads content
from the paths described here. That is the entire integration surface. No
plugin, no SDK, no runtime dependency, no build hook. If you can read JSON and
YAML, you can consume a GreatCMS site: and if you can read only JSON, you can
still consume one, because the schema may be written as JSON too.

Reading this document should be enough to write a consumer in any language in
under half an hour. If it is not, that is a bug in this document.

---

## 1. Repository layout

```
your-site/
├── .cms/
│   ├── schema.yaml       # or schema.json: the content model
│   └── config.yaml       # or config.json: paths and publishing (optional)
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

**Region**: a named slice of a page under CMS control: `home.hero`,
`pricing.faq`. Everything not declared a region is ordinary code the CMS never
sees. This is the hybrid model: a page can have one managed region, or be
entirely managed, and both are the same mechanism.

**Block**: a reusable field set. A _blocks region_ holds an ordered list of
blocks the editor can add, remove, and reorder.

**Collection**: a folder of entries with a shared shape: a blog, case studies,
changelog. Entries are Markdown with YAML frontmatter by default.

---

## 3. `.cms/schema.yaml`

```yaml
version: 1

site:
  name: My Site # optional, shown in the studio
  locale: en # optional, BCP 47; the language the content is written in

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
    label: Articles # optional collection heading in the studio
    entryLabel: article # optional singular noun used by Add/New actions
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

For collections, `label` names the whole list and optional `entryLabel` names
one item. Editors then see “Add article” rather than the generic “New entry”.

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

**Keys the format does not define** are ignored by readers, so a site using an
optional key added in a later revision of version 1 still builds with an older
reader. Authoring tools report them instead (`greatcms check` does), because a
misspelt `requird: true` or `alt: decorative-allowed` otherwise changes the
meaning of a schema without a word.

---

## 4. Field types

Every field accepts `label`, `description`, `required`, and `when`.

| Type        | Extra keys                                      | Stored value                                            |
| ----------- | ----------------------------------------------- | ------------------------------------------------------- |
| `text`      | `min`, `max`, `pattern`, `multiline`, `default` | string                                                  |
| `richtext`  | `allow`, `default`                              | `{ "html": "…", "_ast": … }`                            |
| `number`    | `min`, `max`, `step`, `integer`, `default`      | number                                                  |
| `boolean`   | `default`                                       | boolean                                                 |
| `select`    | `options`, `multiple`, `default`                | string, or array if `multiple`                          |
| `date`      | `time`, `default`                               | ISO 8601 string                                         |
| `link`      | `default`                                       | `{ "href": "…", "label"?: "…", "external"?: bool }`     |
| `image`     | `alt`, `accept`, `default`                      | `{ "src": "…", "alt": "…", "width"?: n, "height"?: n }` |
| `file`      | `accept`, `default`                             | `{ "src": "…", "name"?: "…", "size"?: n }`              |
| `reference` | `collection`, `multiple`                        | entry slug, or array of slugs if `multiple`             |
| `list`      | `of`, `min`, `max`                              | array of the `of` type                                  |
| `group`     | `fields`                                        | nested object                                           |
| `blocks`    | `allow`, `min`, `max`, `default`                | array of block objects, each with `_type`               |

`options` for `select` is either `[a, b]` or `[{ value: a, label: A }]`.

`when` shows a field only while a sibling holds a value, so a hero's slides
appear for the rotating style and its image for the others:

```yaml
style: { type: select, options: [text, image, carousel] }
image: { type: image, when: { field: style, in: [image] } }
slides: { type: blocks, allow: [slide], when: { field: style, equals: carousel } }
```

`field` names a sibling in the same object; `equals` compares one value and
`in` any of several. A hidden field keeps whatever it holds, and validation
does not ask for it: `required` applies only while the field shows.

### Variants

A block can declare named looks. Each instance picks one as `_variant`, and a
block that names none gets the first:

```yaml
blocks:
  cta:
    label: Call to action
    variants: [{ value: navy, label: Navy panel }, { value: light, label: On the page }]
    fields:
      body: { type: richtext, required: true }
```

```json
{ "_type": "cta", "_variant": "light", "body": { "html": "<p>…</p>" } }
```

`variants` takes the same shapes `select` options do. A site branches on
`_variant` where it renders the block; the studio offers it beside the block's
fields and says it in the block's summary line. A `when` condition can name
`_variant` as its field. Resolution fills `_variant` in, so a reader always
sees one, and validation refuses a value the block does not declare.

### Nested blocks

A `blocks` field holds the same shape a blocks region does: an ordered array
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

This is what lets a managed section hold a composed component, a card grid, a
tabbed panel, a set of columns, instead of only flat fields. Nesting is
unbounded: a block reachable through `allow` may itself have a `blocks` field.
A schema that nests a block inside itself is legal, and a consumer is expected
to stop at the depth the content actually has, not to pre-expand the schema.

### References

A `reference` field points at entries of a collection by slug: the entry's
file name without its extension:

```yaml
collections:
  people:
    path: content/people
    fields:
      name: { type: text, required: true }
  blog:
    path: content/blog
    fields:
      title: { type: text, required: true }
      author: { type: reference, collection: people }
      related: { type: reference, collection: blog, multiple: true }
```

```yaml
author: ann-mukamana
related: [publish-from-anywhere, why-git]
```

`collection` must name a collection the schema defines; a schema that names
any other is invalid. The stored value is one slug, or an array of slugs with
`multiple: true`, and a reader returns it as stored: following a reference to
the entry is the site's job, not resolution's. A multiple reference resolves to
`[]` when nothing is stored, and `required` on one means at least one slug.
Whether each slug names an entry that exists cannot be decided from one
document; that check belongs to tools that can see the whole repository.

### Rich text

Rich text is stored as **sanitized HTML** in `html`, so a consumer can print it
with no library at all. Sanitized means an editor stores only markup it can produce
itself: no script, style, frame, event handler, or `javascript:` URL, whatever
was posted to it. The editor's structured document is preserved in `_ast`
for lossless round-tripping. **Consumers should ignore `_ast`.** Any key
beginning with `_` is machinery and may be ignored by consumers.

### Addresses

A link's `href` and an image's or file's `src` are a relative URL, a fragment,
or an `http:`, `https:`, `mailto:` or `tel:` address. Anything else, such as
`javascript:`, `data:` or `vbscript:`, fails validation with `unsafe_url`, so
a site that prints the value into an attribute cannot be made to run script.
Browsers ignore whitespace and control characters inside a scheme, so
validation does too: `java\tscript:` is `javascript:`.

### Images and accessibility

Uploads are committed alongside content, into `content.media`, and served from
`mediaUrlPrefix`. Names are content-addressed so identical bytes reuse a path
and edited bytes get a new one.

`alt` is required by default. A field may set `alt: decorative-allowed`, which
is the only way an empty `alt` validates: making an inaccessible image a
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
imports, or care whether the components exist: that is the site's build, and
it is deliberately none of the CMS's business.

**Frontmatter fences.** An entry has frontmatter when its first line is exactly
`---`. The frontmatter ends at the next line that is exactly `---`, and the body
is everything after that line, verbatim. A trailing carriage return on either
fence is allowed, and a leading byte-order mark is ignored. Empty frontmatter
(`---` twice) is an entry with no fields. Without a closing fence the whole file
is the body.

**YAML means YAML 1.2, with the core schema.** That applies to frontmatter and
to `.cms/*.yaml` alike. Only `true` and `false` are booleans, so a tag written
`no` or `on` is the word; `0777` is seven hundred and seventy-seven; `1:30` is a
string; a duplicated key is an error. Many parsers default to YAML 1.1, where
all of that differs, and a reader built on one must switch it over. A `.json`
file is parsed as JSON.

**Dates stay strings.** YAML has a native timestamp type, so an unconfigured
parser resolves `date: 2026-08-14` into a date object; a `date` field here is an
ISO 8601 **string**. A reader must keep it as one, or it produces documents no
other implementation matches. The Python reader in `examples/reader-python`
replaces PyYAML's 1.1 resolvers with the 1.2 core schema's, which leaves dates as
strings along with everything else.

**A collection entry is not layered over defaults.** Unlike a region, what is in
the file is the whole document: `default` on a collection's fields is an
authoring convenience for a new entry, not a read-time rule. A reader that
filled in defaults would report fields the file does not contain.

JSON files: regions and `json` collection entries: are written with two-space
indentation, the keys of every object sorted by code point at every depth with
`_`-prefixed keys last, and a trailing newline: so diffs stay readable and two
tools writing the same content produce the same bytes. Code point, not locale
collation: `B` sorts before `a` on every machine and in every language.

---

## 6. Resolution rules (the important part)

A consumer resolves a region in three steps. Getting these right is what the
conformance kit checks.

1. **Start from defaults.** Collect `default` from each field; a `reference`
   field with `multiple: true` defaults to `[]`. For a blocks region, the
   default is the region's `default` array, or `[]`.
2. **Apply the region's `default` object** over the field-level defaults,
   merged deeply like everything else, so a region default for one key of a
   group keeps the group's other defaults.
3. **Layer the stored file on top**, if it exists.

Merge rules:

- Objects merge **deeply**, key by key.
- Arrays are **replaced wholesale**: merging lists item-by-item produces
  results no author would predict.
- Within a blocks region, each stored block is merged over its block's field
  defaults, so a field added to a block later still renders. A block whose
  definition has `variants` resolves with `_variant` set: what the content
  names if it is one of them, else the first.
- **A missing content file is not an error.** The region resolves to its
  defaults, so a site builds correctly before the CMS has ever run.
- **A missing schema file _is_ an error.** Defaults live in the schema, so a
  consumer that cannot find it should fail loudly rather than quietly render
  empty regions. The schema is part of the site, committed alongside the code:
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
  commitMessage: "content: update {summary}"
```

Paths must be repository-relative and may not contain `..`.

`preview.paths` tells a studio where a collection entry can be seen on the
site, so its live preview opens the page being edited rather than the front
page. Each collection names a path with `{slug}` in it, or a map from slug to
path with `"*"` as the fallback:

```yaml
preview:
  paths:
    pages: { home: "/", "*": "/{slug}" }
    updates: "/updates/{slug}"
    visit: "/visit/" # a region id, for a region shown on a page of its own
```

A collection without an entry here previews at `/`. A region previews at the
path its id names here, which has no `{slug}`, and otherwise at `/`.

Earlier configs may also contain `publish.branch`, `publish.draftBranchPrefix`,
`publish.dispatchEvent` and `preview.urlTemplate`. They are still accepted, so
those files keep parsing, and nothing reads them.

---

## 8. Publishing

A publish is a **single commit** in the site's working copy, on whatever branch
is checked out, so a region and its images land together or not at all. If the
commit cannot be made, nothing is reported as published. Pushing that commit is
the deploy trigger; whatever CI the repository already had does the rest.

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
the time between render and submit, and link density: never a CAPTCHA, which
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
image with empty alt text: the four cases naive implementations get wrong.

A reference reader in Python (stdlib + PyYAML, ~120 lines) lives at
`examples/reader-python/read.py` and passes the suite. It is the shortest honest
answer to "how hard is this to integrate?".

---

## 10. Versioning

`version: 1` in both files. A consumer that sees a higher major version it does
not recognize should refuse rather than guess. New field types and optional keys
may be added within version 1; anything that changes how existing content
resolves requires a version bump and a documented migration.

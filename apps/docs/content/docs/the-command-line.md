---
title: The command line
summary: Scaffold, extend, type, check, and inspect a site from the terminal.
order: 15
---

Everything the CLI does runs on your machine with your toolchain. It edits the
two files in `.cms/`, reads your content, and never talks to the studio.

## `greatcms init`

```sh
npx greatcms init
```

Detects the framework (Astro, Next, Nuxt, SvelteKit, Eleventy, or nothing in
particular), puts content where that generator already looks for it, writes a
commented `.cms/schema.yaml` and `.cms/config.yaml` with the editor's `$schema`
line for autocomplete, and prints the snippet that reads your first region in
your framework's own syntax.

Templates: `hero` (one region), `landing` (a page of reorderable blocks),
`business` (a complete small-business content model), `blog`, and `blank`.
`--yes` takes every default, and `--framework`, `--template`, `--name`, and
`--dir` override one answer each, so it scripts as well as it prompts. It
refuses to overwrite an existing setup without `--force`.

## `greatcms setup`

```sh
npx greatcms setup ./my-project
```

The guided version. It scans the target directory, detects the framework and
package manager, and finds child projects as well as apps under `apps/`,
`packages/`, and `examples/`. Choose a discovered app or the folder itself, then
either start from a template or build a content model field by field: regions,
reusable sections, reorderable page sections, collections, and groups for
related details such as an owner or opening hours.

Every planned file is shown before anything is written, and cancelling writes
nothing. The scan reads configuration data only. It does not execute project
code, follow symbolic links, or look inside dependencies.

## `greatcms add`

The second managed section is the one that used to mean hand-editing YAML.

```sh
npx greatcms add region about.intro --field heading:text! --field body:richtext
npx greatcms add section testimonial --to home.sections --field quote:richtext! --field name:text!
npx greatcms add block card --field title:text! --field body:text
npx greatcms add collection guides --format mdx --field content:richtext
```

A field is `name:type`, with a trailing `!` for required. Types are `text`,
`richtext`, `image`, `link`, `number`, `boolean`, `date`, `file`, `select(a|b)`,
`list(text)`, and `blocks(card|grid)` for a nested list. `add section` defines a
block and adds it to a reorderable region's allow list in one edit; when the
schema has only one such region, `--to` is optional.

The schema is edited **as text**, so the comments explaining your site's own
decisions survive. It refuses rather than corrupts: a duplicate name, an id the
standard would reject, or a nested block that does not exist all stop before
the file changes. Run it with no fields in a terminal and it asks.

## `greatcms types`

```sh
npx greatcms types --out src/cms.d.ts
```

An interface for every region, block, and collection, with select options as
unions and blocks discriminated by `_type`, plus a module augmentation that
types the reader by id. `cms.region("home.heroo")` becomes a compile error. A
field with a `default` is non-optional, because resolution guarantees it a
value.

`--check` exits non-zero when the committed file no longer matches the schema,
which is how CI notices a schema change nobody regenerated the types for. A
site that never runs it loses nothing: without the file, the reader takes any
string.

## `greatcms check`

```sh
npx greatcms check
# content: OK (3 regions, 6 entries, 1 media reference)
```

Validates every content file and collection entry against the schema and exits
non-zero if anything would not render: a required field left empty, a field
the schema no longer has, a file no region renders any more, frontmatter that
will not parse, an image pointing at a file nobody committed. Each report names
the file, the field path, and what to do. `--json` gives the same report to a
machine.

A region with no content file is never a failure. It renders schema defaults,
and `check` says so.

## `greatcms doctor`

Prints every region, the file it resolves to, which ones are still rendering
schema defaults, and any unsaved edit left in `.cms/draft/`: the one thing that
shows in your dev server and nowhere else.

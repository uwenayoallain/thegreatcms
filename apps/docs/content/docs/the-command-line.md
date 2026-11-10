---
title: The command line
summary: Scaffold, extend, type, check, and inspect a site from the terminal.
order: 15
---

Everything the CLI does runs on your machine with your toolchain. It edits the
two files in `.cms/`, reads your content, and never talks to a studio. One
command, `greatcms studio`, runs one: on this machine, for this folder.

`greatcms help <command>` (or `greatcms <command> --help`) shows a command's
options and examples, and `greatcms --version` prints the version. Short flags
work where they exist (`-y` for `--yes`, `-f` for `--force`, `-o` for `--out`),
`--` ends the options, and a misspelt command or option gets a suggestion
rather than silence. `--no-color` or `NO_COLOR=1` gives plain text.

The exit status is meant for scripts: `0` when done, `1` when the command failed
or found problems (such as `check` finding content that will not render), `2`
when it was called wrongly, and `130` when you cancelled a prompt.

## Tab completion

`greatcms completion <shell>` prints a completion script for bash, zsh or fish,
covering commands, options, and the values they take:

```sh
greatcms completion bash > ~/.local/share/bash-completion/completions/greatcms
greatcms completion zsh > "${fpath[1]}/_greatcms"
greatcms completion fish > ~/.config/fish/completions/greatcms.fish
```

## `greatcms init`

```sh
npx greatcms init
```

Detects the framework (Astro, Next, Nuxt, SvelteKit, or nothing in
particular), puts content where that generator already looks for it, writes a
commented `.cms/schema.yaml` and `.cms/config.yaml` with the editor's `$schema`
line for autocomplete, and prints the snippet that reads your first region in
your framework's own syntax.

Templates: `hero` (one region), `landing` (a page of reorderable blocks),
`business` (a complete small-business content model), `blog`, and `blank`.
It also adds `@greatcms/reader` to `package.json` and connects the studio's
live preview in your framework's config: one additive line each, shown before
anything is written. A config it does not recognise is left alone and the line
is printed instead; `--no-wire` skips this step entirely.

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
# content: OK (3 regions, 6 entries, 1 media reference, 4 internal links)
```

Validates every content file and collection entry against the schema and exits
non-zero if anything would not render, or would render broken:

- a required field left empty, a field the schema no longer has, a file no
  region renders any more, frontmatter that will not parse;
- an image or file pointing at an upload nobody committed, whether it sits in
  an image field, a link, a rich-text `<img>`, or a Markdown `![]()`;
- an internal link to an entry that does not exist.

Each report names the file, the field path, and what to do.

Internal links are link fields, rich-text `<a href>`, and Markdown links whose
target starts with `/`. `check` drops the `#fragment`, the `?query`, a trailing
`.html` and a trailing slash, then reads the path back through
`preview.paths` in `.cms/config.yaml`: with `updates: "/updates/{slug}"`,
`/updates/launch` is broken unless `content/updates/launch.md` exists, and with
`pages: { home: "/", "*": "/{slug}" }`, `/` needs a `home` page. A path that
matches no pattern, like `/assets/report.pdf`, is a route the site writes
itself and is left alone, as is the index a pattern sits under (`/updates`).
Without `preview.paths`, links are counted but not checked.

Some things are worth fixing but never break a build. `check` reports them as
warnings, lists them apart from problems, and still exits zero:

- an upload in `content.media` that no region, entry, unpublished draft or
  schema default refers to (dotfiles such as `.gitkeep` are ignored). `check`
  only reads content, so a file the site's own code imports shows up here too;
- a rich-text link with no text, which a screen reader announces as its URL;
- headings in one rich-text field that skip a level, such as `h2` then `h4`.

`--json` gives the same report to a machine: `ok` is false only when `issues`
is non-empty, and warnings come in their own `warnings` array.

A region with no content file is never a failure. It renders schema defaults,
and `check` says so.

## `greatcms doctor`

Prints every region, the file it resolves to, which ones are still rendering
schema defaults, and any unsaved edit left in `.cms/draft/`: the one thing that
shows in your dev server and nowhere else.

## `greatcms studio`

```sh
npx greatcms studio
```

Opens the visual editor for the site in this folder, or the nearest folder
above it with a `.cms/schema.yaml`: the studio on `127.0.0.1:4983`, your
browser signed in through a link that works once, and the site's dev server
as the live preview. `--port`, `--dev-url`, `--no-dev` and `--no-open` change
the defaults; [Running the studio](/docs/running-the-studio/#on-your-own-machine)
has the details. The dev server is started by this command, as your own dev
script would be; the studio still runs nothing from the repository.

## `greatcms describe`

The content model in one screen, for whoever is about to write content by
hand: a person, or a coding agent. Every region with its file, every block
with its variants, every collection with its entry path, the slugs that exist
and the page each becomes; and each field as one line with its type, limits,
condition, default and the schema's own description:

```
region home.hero → content/cms/home.hero.json
  eyebrow: text (≤ 60 chars)
  lines: list<text> (1–4 items)  # The headline, one line per item
  primary!: link
block selected-work  _variant: grid | stacked (first is the default)
  heading!: text (≤ 60 chars)
collection work → content/work/<slug>.json  page /work/{slug}/
  entries: atlas-rail, fernhouse, lumen, oculi, tidewater
```

`!` marks a required field. `--json` gives the same outline as data.

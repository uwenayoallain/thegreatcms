# thegreatcms

A Git-backed CMS for sites that shouldn't need one at runtime.

You pick which parts of a page it manages — a hero here, a feature list there,
an entire blog, or the whole site. Everything else stays hand-written code the
CMS never sees. Publishing writes files to your repository; the commit triggers
whatever deploy pipeline you already had. One studio manages many websites and
collects the things Git can't hold — form submissions — into a single inbox.

**It is not a framework plugin.** The integration surface is a schema file and
some JSON, so a site consumes it with an import and no dependency. `greatcms
init` scaffolds for Astro, Next, Nuxt, SvelteKit, and Eleventy. The format
itself stays language-agnostic — it is JSON on disk, and a Python reader passes
the same conformance suite — but the tooling claims only what it is exercised
against.

Read [SPEC.md](./SPEC.md) — that document is the actual product.

---

## Status

On M5 of 5. The standard is proven from two languages, the studio edits a folder
on this machine and shows the result in your own site as you type, and form
submissions from any site land in one inbox.

|                         |                                                                              |
| ----------------------- | ---------------------------------------------------------------------------- |
| ✅ **M0** Foundation    | pnpm + Turborepo, oxlint + oxfmt (Rust), tsdown/Rolldown, Vitest             |
| ✅ **M1** The standard  | `@greatcms/spec`, conformance kit, Node reader, Astro example, Python reader |
| ✅ **M2** Studio        | Auth, multi-site registry, schema-generated editor, atomic publishes         |
| ✅ **M3** Preview       | Live editing in your own dev server                                          |
| ✅ **M4** Dynamic layer | Forms, inbox, email                                                          |
| 🔄 **M5** Hardening     | a11y gates, perf budgets, CLI, browser tests, agent docs                     |

## What's here

```
apps/studio/            The CMS: sign in, connect site folders, edit regions, publish
apps/docs/              The website — landing page and docs, managed by GreatCMS itself
packages/cli/           `greatcms init`, `add`, `types`, `check`, `doctor`
packages/spec/          The standard: schema parsing, validation, resolution rules
packages/conformance/   Fixtures + verifier that prove a tool reads it correctly
packages/reader/        Build-time reader for any JS framework
examples/site-astro/    A real Astro site: managed regions beside hand-written markup
examples/business-astro/ A business starter: flexible sections and structured products
examples/reader-python/ The same standard, implemented in ~120 lines of Python
```

## Try it

```bash
pnpm install
pnpm build
pnpm test
```

Run the studio:

```bash
pnpm --filter @greatcms/studio build
STUDIO_PASSWORD='something long' pnpm --filter @greatcms/studio start
# http://localhost:8787
```

Or, while developing, `STUDIO_PASSWORD='something long' pnpm dev` runs the
studio and the Astro example together, both rebuilding on change. `pnpm studio`
runs the studio alone. Node 22.18 or newer; `.node-version` says so for
version managers, and `.vscode/` recommends the oxc extension and wires the
JSON Schemas to `.cms/*.yaml` for autocomplete.

Point it at a folder containing a `.cms/schema.yaml` and it builds the editor
from your schema. Point any site's
contact form at `https://your-studio/f/{siteId}/contact` and the messages arrive
in the inbox — set `RESEND_API_KEY`, `NOTIFY_FROM`, and `NOTIFY_TO` to be emailed
about them too. Or run it as a
container — `apps/studio/Dockerfile`, one process, one SQLite file, one volume.
For a server that also builds and serves the site on every publish, pair it with
`greatcms-deploy` (`packages/deploy`); `examples/business-astro/deploy/` is the
whole arrangement as a Compose file, Caddy included.

Behind a reverse proxy, set `STUDIO_TRUST_PROXY=1` so rate limiting sees the
visitor's address rather than the proxy's, and so the session cookie is marked
`Secure`. Leave it unset when the studio is reachable directly: the forwarding
headers are then the visitor's to forge. The studio uses the last
`X-Forwarded-For` entry, the one your proxy appended. Behind Cloudflare, set
`STUDIO_TRUST_PROXY=cloudflare` instead, so `CF-Connecting-IP` is used.
Changing `STUDIO_PASSWORD` signs every open session out.

Then look at the example site:

```bash
pnpm --filter @greatcms/example-site-astro dev     # http://localhost:4321
pnpm --filter @greatcms/example-business-astro dev # the business starter, on the next free port
```

The home page shows a managed hero next to a hand-written section — both end up
in the same static HTML. The about page renders from schema defaults, because
nobody has ever edited it.

The business example is the larger proof: company, owner/contact and search
details, nested reorderable feature and process sections, products, and managed
pages all feed a polished multi-page site. One dynamic route means adding an
About, Services, or legal page is one new collection entry rather than another
schema change. Its components remain site-owned, and its built pages still
contain zero client JavaScript.

## Setting up a site

For guided setup from this checkout:

```bash
pnpm build
pnpm greatcms setup /path/to/your-project
```

`setup` scans the target directory, detects its JavaScript framework and package
manager, and finds immediate child projects as well as projects under `apps/`,
`packages/`, and `examples/`. This also works for a folder of independent SME sites;
it does not require a monorepo manifest.
Choose the current folder or a discovered app. A missing target directory becomes
a new CMS project; an existing schema is extended without replacing its content.
The scan reads configuration data, never executes project code, and does not
traverse dependencies, Git internals, or symbolic links.

Choose **Build my own content model** to create editable regions, reusable
sections, reorderable page sections, and collections in one session. Fields have
guided names, types, labels, required settings, defaults, and choice lists.
Choose a **Group** field for related details such as an owner, address, or opening
hours, then define its fields in the same wizard. Groups can contain other groups.
Templates remain optional starting points. Finish to review every planned file;
cancelling before confirmation writes nothing.

The optional integration creates a build-time reader at `.cms/reader.mjs`, typed
declarations, and `cms:check`, `cms:types`, and `cms:setup` package scripts. Existing
dependencies and scripts are retained. From a built development checkout, new
dependencies link to the local GreatCMS packages: these packages are not yet
published, so keep that checkout available. Install with the detected package
manager after setup, then import the reader from your site's build/server code.
Connect the project folder in your local studio to edit its content. Setup does
not generate website pages, replace framework configuration, install packages,
or start a studio server. Repeat it for another workspace app or more content.

Bare `greatcms init` opens the same wizard in an interactive terminal. Explicit
template options and `--yes` retain the scriptable scaffold workflow below.
The commands below assume the CLI has been installed or linked; from this
checkout, `pnpm greatcms <command>` runs the same binary, so read `npx greatcms`
as that until a package is published.

```bash
npx greatcms init
```

It detects what you build with — Astro, Next, Nuxt, SvelteKit, Eleventy, or
nothing in particular — and puts content where that generator already looks for
it: `_data/cms` for Eleventy, `src/content/cms` for Astro, `content/cms` for
Next. Then it asks what you want managed (one hero, a landing page, a complete
small-business site, a blog, or nothing yet), writes a
commented `.cms/schema.yaml` and `.cms/config.yaml` with the editor's
`$schema` line for autocomplete, and prints the snippet for reading your first
region **in your framework's own syntax**, through the reader so schema defaults
work before the first content file exists.

The `business` template is the quickest route for product and service sites:

```bash
npx greatcms init --template business
```

It starts with company, owner/contact and search details, a home hero,
reorderable feature, ordered process, statistics, story, product, FAQ, and
call-to-action sections, plus JSON collections for products and pages. Point
the pages collection at one dynamic route and editors can add normal or legal
pages without touching the schema. These are content shapes rather than styled
components: your site keeps complete control of its markup and visual identity.

`--yes` takes every default; `--framework`, `--template`, `--name`, and `--dir`
override individually, so it scripts as well as it prompts. It
refuses to overwrite an existing setup without `--force`.

## Managing one more part of the page

The second section is the one that used to mean hand-editing YAML. It does not:

```bash
npx greatcms add region about.intro --field heading:text! --field body:richtext
npx greatcms add section testimonial --to home.sections --field quote:richtext! --field name:text!
npx greatcms add block card --field title:text! --field body:text
npx greatcms add block grid --field cards:'blocks(card)'
npx greatcms add collection guides --format mdx --field content:richtext
```

`name:type` per field, a trailing `!` for required, `select(a|b)`,
`list(text)`, and `blocks(card|grid)` for a nested list of components. Run it
with no fields and a terminal, and it asks.

`add section` handles the common composed-page case: it defines the block and
adds it to a reorderable region's allow list in one text-preserving edit. When
there is only one such region, `--to` is optional. Implement that `_type` once
in the site's renderer; editors can reuse it from then on. `add block` remains
available for lower-level or nested content shapes.

It edits the schema **as text**, so the comments explaining your site's own
decisions survive — a parse-and-redump would throw them away. It refuses rather
than corrupts: a duplicate name, an id the standard would reject, or a nested
block type nobody has defined stops the command and names the one that fixes
it. Then it prints how to read the new section in your framework's syntax.

## Types from the schema you already wrote

```bash
npx greatcms types --out src/cms.d.ts
```

Interfaces for every region, block, and collection — select options as unions,
blocks discriminated by `_type`, nested blocks typed by what they allow — plus a
module augmentation that types the reader by id:

```ts
const hero = cms.region("home.hero"); //  HomeHeroRegion
hero.headng; //  compile error, not undefined at build time
cms.region("home.heroo"); //  compile error
```

A field with a `default` is non-optional, because resolution guarantees it a
value. Run it in a build script or in CI, and a schema change that breaks a
template fails the build instead of quietly rendering nothing.

Nothing changes for a site that does not run it: without the generated file the
reader takes any string, as it always did.

## Connecting a site

A site is **a folder on this machine**. The studio reads and writes the working
copy directly — no token, no network, no push. Publishing writes the files and
commits them if the folder is a Git repository. Give it your dev server's URL
and the editor shows **your real components**, from your own build, updating as
soon as your dev server reloads.

There is deliberately no hosted-repository backend. It existed, and it made
every screen ask which of two worlds it was in; the local path is the one worth
getting right first.

For an Astro site, add the integration so an edit — published or still being
typed — reloads the page:

```js
import greatcms from "@greatcms/reader/astro";
export default defineConfig({ integrations: [greatcms()] });
```

For any other Vite-based site, the plugin does the same:

```js
import { greatcmsWatch } from "@greatcms/reader/vite";
export default defineConfig({ vite: { plugins: [greatcmsWatch()] } });
```

Both are dev-only, and both also hide the framework's dev toolbar **while the
page is framed by the studio** — it belongs on your own tab, not on top of the
section you are editing. Your own tab keeps it. Pass
`{ hideDevOverlays: false }` to keep it everywhere.

The reader uses the filesystem on purpose — that is what keeps it
framework-neutral — which also means Vite cannot know a content file is a
dependency. Without the watcher the file changes and the page does not, which is
worse than an error because it looks like nothing happened.

The studio needs four operations from a repository — read a file, list a
directory, read the head commit, commit a set of files. Everything above that
line is backend-agnostic, which is what keeps the editor, the validation, and
the publish free of any knowledge of where the bytes are.

## Publishing

A publish writes the files and commits them, in one commit. Your existing deploy
pipeline takes it from there — the CMS is not in that path.

If the folder is not a Git repository, the files are simply written, which is
the whole job.

**Your own dev server is the preview.** Connect the site with its dev server
URL and the editor frames it, rendering your real components as you type — the
unsaved edit is written to `.cms/draft/`, which the reader prefers over the
committed file in development and never in a build. The framed page is
dissected into its sections: point at a heading or a card and click, and its
field opens in the form; focus a field and the page scrolls to where it shows.

`npx greatcms doctor` prints what a repository's setup looks like: regions,
where each one's file lives, which are still rendering schema defaults, and any
unsaved edit left in `.cms/draft/` — the one thing that shows in your dev server
and nowhere else.

## Checking content in your own CI

The studio validates before it commits, so nothing invalid arrives through the
editor. But content is files in Git: you, a script, or an agent can edit them
directly, and a schema change can invalidate content that was correct when it
was written. Neither of those passes through the studio.

```bash
npx greatcms check
# content: OK (3 regions, 6 entries, 1 media reference)
```

It exits non-zero, so it belongs in a build. It reports a required field left
empty, a field the schema no longer has, a content file no region renders any
more, an entry whose frontmatter will not parse, and an image pointing at a file
nobody committed — each with the file, the field path, and what to do about it.
`--json` gives the same report to a machine.

A missing content file is never a failure. That resolves to schema defaults by
design, and `check` says so rather than complaining about it.

## Proofs, not claims

Each of these is an automated test, not a bullet point in a pitch:

**It works in another language.** A Python reader written from `SPEC.md` alone
passes the same conformance suite:

```bash
python3 examples/reader-python/read.py packages/conformance/fixtures /tmp/out
node packages/conformance/bin/greatcms-conformance.mjs verify /tmp/out
# conformance: PASS (5 regions)
```

**It ships nothing to the browser.** The built example sites, and this
website, contain zero `<script>` tags, and each carries a weight budget its
tests assert — `examples/site-astro/tests/a11y.test.ts` is the smallest.

**It is accessible.** axe runs against every page of the example site _and_
every screen of the studio, every form control is labelled, and errors are
attached with `aria-invalid` and `aria-describedby` rather than colour alone.
Colour contrast is judged in Chromium, against real layout, because that is the
one failure a static check cannot see and a reader cannot miss.

**The visual editor is tested in a browser.** Chromium loads the studio and
asserts what a person gets: ProseMirror mounts over the textarea, the toolbar
applies marks and reports its own pressed state, the preview updates as you type
without committing anything — and with JavaScript switched off, the same screen
still edits and publishes from a plain textarea.

**The admin degrades to plain HTML.** Every mutation is a form POST — including
adding, removing, and reordering blocks — so the studio is keyboard- and
screen-reader-navigable by construction rather than by patching ARIA onto custom
widgets. Rich text gets a visual editor built directly on **ProseMirror** (MIT,
no commercial tier), loaded only on screens that have a richtext field. It is an
enhancement over a real textarea: if the bundle never loads, you can still edit
and publish.

**A publish is one commit, or nothing.** Invalid content is refused before it
reaches the repository, a working copy that moved while you were editing gets a
409 rather than an overwrite, and a commit Git refuses is reported as an error.

**The studio never runs your code.** It reads your schema and writes content —
that is the whole interaction, and it never runs your Git hooks. Previews render
in your own dev server, which is also why one studio can manage several sites
without carrying a toolchain for each of them.

**Form submissions need nothing on the site.** A plain HTML `<form>` posting to
the studio is the whole integration — no JavaScript, no third-party form
service, no per-site backend. Spam is scored with a honeypot, submission timing,
and a rate limit rather than a CAPTCHA, which is an accessibility tax paid by
every legitimate visitor to inconvenience a bot that solves them anyway.

**The awkward cases are covered.** The conformance fixture includes a region
with no content file, a region edited before a field was added to the schema, a
block missing a defaulted field, and a decorative image with empty alt text —
the four things naive implementations get wrong.

## Toolchain

Rust where a Rust tool exists, because build and check times are a feature:

| Job            | Tool                        | Why                                    |
| -------------- | --------------------------- | -------------------------------------- |
| Lint           | **oxlint** (oxc)            | Whole repo in ~1.4s, hundreds of rules |
| Format         | **oxfmt** (oxc)             | 65 files in ~0.7s, multi-threaded      |
| Library builds | **tsdown** (Rolldown + oxc) | ESM + declarations in ~2s per package  |
| Site builds    | **Vite 8 (Rolldown)**       | Astro build went 3.6s → 1.8s           |
| Task graph     | **Turborepo** (Rust)        | Content-hashed caching across packages |
| Tests          | **Vitest 4**                | Runs on the same Rolldown pipeline     |

## Design decisions worth knowing

**Content is JSON; prose is Markdown.** Every language parses JSON with no
dependencies, and every static site generator already has a Markdown pipeline.
Using one format for both would have fought one of those two facts.

**Rich text is sanitized HTML, with the editor AST beside it.** A consumer that
just wants to print a paragraph needs no library. `_ast` is there for anyone who
wants structural control, and is safe to ignore.

**Alt text is structurally required.** The only way to store an empty `alt` is a
field explicitly marked `alt: decorative-allowed`, which makes an inaccessible
image a deliberate act rather than an oversight.

**A missing content file is never an error.** It resolves to schema defaults, so
a site is correct before the CMS has ever been opened. A missing _schema_ file
is an error — failing loudly beats quietly rendering empty regions.

**Publishing is one commit.** Every file a publish touches is written before
anything is staged, so a region and the images it references land together or
not at all. Half-applied content is how a branch stops building.

## The website

`apps/docs` is the project's site: a landing page and the documentation. Its
landing copy — the headline, the four claims, the closing note — is **managed by
GreatCMS**, stored as JSON in this repository and edited in the studio like any
other site. The docs are a Markdown collection, like any blog. The layout
around all of it is ordinary Astro the CMS has never seen.

The standard page renders `SPEC.md` directly, so the published standard and the
one the code implements cannot drift, and the two JSON Schemas are served from
`packages/spec` for the same reason. Every heading is linkable, every page has
a Markdown twin at its own path plus `.md`, and there is a sitemap, a 404 page,
and no JavaScript. It builds to about 120 KB of HTML and CSS across fourteen
pages, and holds the same axe, dead-link, and weight gates as everything else.

```bash
pnpm --filter @greatcms/docs dev
```

## For agents

The docs are published in a form a coding agent can consume in one fetch, since
"integrate from SPEC.md in half an hour" should be true for tools as well as
people:

```
/llms.txt                     index and integration summary
/llms-full.txt                every document in one file
/docs.json                    manifest, with agentEntrypoints and the integration steps
/spec.md  /docs/<page>.md     each page as the Markdown it was written in
/json-schema/*.schema.json    JSON Schema for .cms/schema.yaml and .cms/config.yaml
```

They are generated from `SPEC.md`, `README.md`, and the docs collection by
`pnpm run docs:build`, and CI fails if they drift.

For an agent working inside a site, [skills/greatcms](./skills/greatcms/SKILL.md)
is an installable skill with the commands, file shapes and pitfalls
(`npx skills add greatcms/greatcms@greatcms`); `greatcms init` leaves a note in
the site's own `AGENTS.md`; and `greatcms check --json` and `greatcms doctor
--json` answer in a form a script can act on. [AGENTS.md](./AGENTS.md) covers
working _on_ GreatCMS — the invariants that are design decisions rather than
implementation details.

## Licence

MIT.

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
| ✅ **M3** Preview       | Live editing in your own dev server; draft branch + your CI                  |
| ✅ **M4** Dynamic layer | Forms, inbox, email                                                          |
| 🔄 **M5** Hardening     | a11y gates, perf budgets, CLI, browser tests, agent docs                     |

## What's here

```
apps/studio/            The CMS: sign in, connect repos, edit regions, publish
apps/docs/              The website — landing page and docs, managed by GreatCMS itself
packages/cli/           `greatcms init`, `add`, `types`, `preview`, `check`, `doctor`
packages/spec/          The standard: schema parsing, validation, resolution rules
packages/git/           Atomic multi-file commits via the GitHub Git Data API
packages/conformance/   Fixtures + verifier that prove a tool reads it correctly
packages/reader/        Build-time reader for any JS framework
examples/site-astro/    A real Astro site: managed regions beside hand-written markup
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

Connect a repository containing a `.cms/schema.yaml` and a token with
`contents: write`, and it builds the editor from your schema. Point any site's
contact form at `https://your-studio/f/{siteId}/contact` and the messages arrive
in the inbox — set `RESEND_API_KEY`, `NOTIFY_FROM`, and `NOTIFY_TO` to be emailed
about them too. Or run it as a
container — `apps/studio/Dockerfile`, one process, one SQLite file, one volume.

Behind a reverse proxy, set `STUDIO_TRUST_PROXY=1` so rate limiting sees the
visitor's address rather than the proxy's, and so the session cookie is marked
`Secure`. Leave it unset when the studio is reachable directly: the forwarding
headers are then the visitor's to forge. Changing `STUDIO_PASSWORD` signs every
open session out.

Then look at the example site:

```bash
pnpm --filter @greatcms/example-site-astro dev     # http://localhost:4321
```

The home page shows a managed hero next to a hand-written section — both end up
in the same static HTML. The about page renders from schema defaults, because
nobody has ever edited it.

## Setting up a site

```bash
npx greatcms init
```

It detects what you build with — Astro, Next, Nuxt, SvelteKit, Eleventy, or
nothing in particular — and puts content where that generator already looks for
it: `_data/cms` for Eleventy, `src/content/cms` for Astro, `content/cms` for
Next. Then it asks what you want managed (one hero, a
landing page with reorderable blocks, a blog, or nothing yet), writes a
commented `.cms/schema.yaml` and `.cms/config.yaml` with the editor's
`$schema` line for autocomplete, and prints the snippet for reading your first
region **in your framework's own syntax**.

`--yes` takes every default; `--framework`, `--template`, `--name`, `--dir`, and
`--branch` override individually, so it scripts as well as it prompts. It
refuses to overwrite an existing setup without `--force`.

## Managing one more part of the page

The second section is the one that used to mean hand-editing YAML. It does not:

```bash
npx greatcms add region about.intro --field heading:text! --field body:richtext
npx greatcms add block card --field title:text! --field body:text
npx greatcms add block grid --field cards:'blocks(card)'
npx greatcms add collection guides --format mdx --field content:richtext
```

`name:type` per field, a trailing `!` for required, `select(a|b)`,
`list(text)`, and `blocks(card|grid)` for a nested list of components. Run it
with no fields and a terminal, and it asks.

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

## Two kinds of site

**A folder on this machine.** Point the studio at a checkout and it reads and
writes the working copy directly — no token, no network, no push. Publishing
writes the files and commits them if the folder is a Git repository. Give it your
dev server's URL and the editor shows **your real components**, from your own
build, updating as soon as your dev server reloads.

**A GitHub repository.** Publishing commits over the API and your pipeline
deploys it, as below.

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

The studio needs exactly seven operations from a repository, and nothing about
them is specific to GitHub — which is why a folder works without a second code
path through the editor, the validation, or the publish.

## Publishing

Local sites write to the working copy and commit there — that is the path in
active use.

The GitHub path below is built and tested, but is not the current focus:
deployment is a later milestone. It is documented so it is not a surprise, not
because you need it yet.

**Direct** commits to your publish branch.

**Pull request** commits to a draft branch and opens a PR against it, so a
content change gets the same review, CI preview build, and revert-to-roll-back
that a code change does. Saving again updates the open pull request rather than
opening a second one.

Pull request titles are generated **from the actual field diff**:

> Update heading in Home hero on Example

with a table of every changed field in the body. That is the default, it needs
no model, and it is always accurate.

A site can opt in to having a model write the title instead. Point the studio at
any OpenAI-compatible endpoint and it works — Groq, Google's Gemini, Cloudflare
Workers AI, Mistral, or a local Ollama:

```bash
AI_BASE_URL=https://api.groq.com/openai/v1 AI_API_KEY=... AI_MODEL=llama-3.3-70b-versatile
```

Two things hold regardless: **publishing never waits on a model** — the call is
time-boxed and every failure falls back to the generated title — and the PR body
stays machine-generated, because a reviewer needs the change list to be true
rather than fluent. It is off by default per site, since it sends your content to
a third party.

## Images

Upload one in the editor and it is committed **in the same commit** as the
content that points at it. That is what the hand-built Git tree was for: if the
picture and the JSON referencing it landed separately, every deploy in between
would build a page with a broken image.

Width and height are read from the file's own header — no dependency, no
trusting the browser — so the stored value carries the intrinsic size and pages
do not reflow as images load. Files are content-addressed
(`hero-shot-a1b2c3d4.png`), so re-uploading identical bytes reuses the path
while an edited image gets a fresh URL that busts any cache holding the old one.

SVG is deliberately not accepted: it is a script-bearing document, and an editor
uploading one would be a stored-XSS vector on the published site. Alt text stays
required — uploading does not bypass validation.

## Previewing a draft

Three ways, at three speeds. None of them runs your code on our server.

**As you type, in your own site.** For a folder on this machine, the editor
shows your dev server beside the form. Each edit is written to `.cms/draft/` in
your working copy, your dev server reloads, and your real components render
content nobody has published. Nothing is committed, nothing leaves the machine,
and a draft can never reach a live site: the reader only reads `.cms/draft/` in
development, and the directory ignores itself in Git.

Publishing writes the real file and clears the draft. There is no synthetic
preview to disagree with your site, because the thing on screen _is_ your site.

**Your CI builds it.** For a GitHub repository, "Save draft & preview" commits
to `cms/draft-<region>`; set `preview.urlTemplate` in `.cms/config.yaml` and the
studio iframes the resulting URL.

**Or your own dev server builds it:**

```bash
npx greatcms preview --branch cms/draft-home.hero --run "npm run dev"
```

That overlays the draft's content files onto your working copy, starts your dev
server, and restores the working copy exactly when you stop it — including
deleting files that did not exist before. It refuses to run on top of
uncommitted content changes, and refuses any draft branch carrying changes
outside your content directories, because a draft is content, not code.

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

**It ships nothing to the browser.** The built example site contains zero
`<script>` tags and weighs 34 KB across four pages — asserted in
`examples/site-astro/tests/a11y.test.ts`.

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
reaches the repository, and a branch that moved while you were editing gets a
409 rather than an overwrite.

**The studio never runs your code.** It reads your schema and writes content —
that is the whole interaction. Preview builds happen on your CI or your laptop,
which is also why one studio can manage several sites without carrying a
toolchain for each of them.

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
| Site builds    | **rolldown-vite**           | Astro build went 3.6s → 1.8s           |
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

**Publishing is one atomic commit.** Blob → tree → commit → ref via the GitHub
Git Data API, so a region and its images land together or not at all. Repeated
`PUT /contents` calls can half-apply, and half-applied content is how `main`
stops building.

## The website

`apps/docs` is the project's site: a landing page and the documentation. Its
landing copy — the headline, the four claims, the closing note — is **managed by
GreatCMS**, stored as JSON in this repository and edited in the studio like any
other site. The layout around it is ordinary Astro the CMS has never seen.

The standard page renders `SPEC.md` directly, so the published standard and the
one the code implements cannot drift. It builds to 111 KB across nine pages,
ships no JavaScript, and holds the same axe and weight gates as everything else.

```bash
pnpm --filter @greatcms/docs dev
```

## For agents

The docs are published in a form a coding agent can consume in one fetch, since
"integrate from SPEC.md in half an hour" should be true for tools as well as
people:

```
/llms.txt        index and integration summary
/llms-full.txt   every document in one file
/docs.json       manifest, with agentEntrypoints and the integration steps
```

They are generated from `SPEC.md` and `README.md` by `pnpm run docs:build`, and
CI fails if they drift. [AGENTS.md](./AGENTS.md) covers working _on_ GreatCMS —
the invariants that are design decisions rather than implementation details.

## Licence

MIT.

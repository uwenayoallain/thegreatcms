# thegreatcms

A Git-backed CMS for sites that shouldn't need one at runtime.

You pick which parts of a page it manages — a hero here, a feature list there,
an entire blog, or the whole site. Everything else stays hand-written code the
CMS never sees. Publishing writes files to your repository; the commit triggers
whatever deploy pipeline you already had. One studio manages many websites and
collects the things Git can't hold — form submissions, comments — into a single
inbox.

**It is not a framework plugin.** The integration surface is a schema file and
some JSON. Astro, Hugo, Eleventy, Next, Jekyll, Laravel, or a hand-rolled Go
generator all consume it the same way, in whatever language they're written in.

Read [SPEC.md](./SPEC.md) — that document is the actual product.

---

## Status

Milestone 4 of 5 (M3 and M4 both done). The standard is proven from two languages, the studio edits
and publishes real content to a real repository, and form submissions from any
site land in one inbox.

|                         |                                                                              |
| ----------------------- | ---------------------------------------------------------------------------- |
| ✅ **M0** Foundation    | pnpm + Turborepo, oxlint + oxfmt (Rust), tsdown/Rolldown, Vitest             |
| ✅ **M1** The standard  | `@greatcms/spec`, conformance kit, Node reader, Astro example, Python reader |
| ✅ **M2** Studio        | Auth, multi-site registry, schema-generated editor, atomic publishes         |
| ✅ **M3** Preview       | Draft branch + your own CI, iframed                                          |
| ⬜ **M4** Dynamic layer | Forms, comments, inbox, email                                                |
| 🔄 **M5** Hardening     | a11y gates, perf budgets, CLI, agent docs                                    |

## What's here

```
apps/studio/            The CMS: sign in, connect repos, edit regions, publish
packages/cli/           `greatcms preview` and `doctor` — the local half
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

It detects what you build with — Astro, Next, Nuxt, SvelteKit, Eleventy, Hugo,
Jekyll, or nothing in particular — and puts content where that generator already
looks for it: `data/cms` for Hugo, `_data/cms` for Eleventy and Jekyll,
`src/content/cms` for Astro. Then it asks what you want managed (one hero, a
landing page with reorderable blocks, a blog, or nothing yet), writes a
commented `.cms/schema.yaml` and `.cms/config.yaml` with the editor's
`$schema` line for autocomplete, and prints the snippet for reading your first
region **in your framework's own syntax**.

`--yes` takes every default; `--framework`, `--template`, `--name`, `--dir`, and
`--branch` override individually, so it scripts as well as it prompts. It
refuses to overwrite an existing setup without `--force`.

## Publishing: straight to the branch, or as a pull request

Chosen per site when you connect it.

**Direct** commits to your publish branch. Fastest path from edit to live.

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

Two ways, and neither runs your code on our server.

**Your CI builds it.** "Save draft & preview" commits to `cms/draft-<region>`;
set `preview.urlTemplate` in `.cms/config.yaml` and the studio iframes the
resulting URL.

**Or your own dev server builds it, right now:**

```bash
npx greatcms preview --branch cms/draft-home.hero --run "npm run dev"
```

That overlays the draft's content files onto your working copy, starts your dev
server, and restores the working copy exactly when you stop it — including
deleting files that did not exist before. It refuses to run on top of
uncommitted content changes, and refuses any draft branch carrying changes
outside your content directories, because a draft is content, not code.

`npx greatcms doctor` prints what a repository's setup looks like: regions,
where each one's file lives, and which are still rendering schema defaults.

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

**The admin needs no JavaScript either.** The studio is server-rendered and
every mutation is a form POST — including adding, removing, and reordering
blocks. That is what makes it keyboard- and screen-reader-navigable by
construction rather than by patching ARIA onto custom widgets.

**A publish is one commit, or nothing.** Invalid content is refused before it
reaches the repository, and a branch that moved while you were editing gets a
409 rather than an overwrite.

**The studio never runs your code.** It reads your schema and writes content —
that is the whole interaction. Preview builds happen on your CI or your laptop,
which is also why one studio can manage an Astro site, a Hugo site, and a
Laravel site without carrying three toolchains.

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

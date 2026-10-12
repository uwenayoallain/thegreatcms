# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read [AGENTS.md](./AGENTS.md) first — it holds the invariants (design decisions
that must not be "fixed") and the current focus. This file covers commands and
the architecture that spans several files.

## Commands

```sh
pnpm install
pnpm check        # the gate: oxlint, oxfmt --check, docs:check, typecheck, test
pnpm build        # turbo run build (tsdown per package; Astro for the sites)
pnpm test         # turbo run test (build runs first — tests import dist/)
pnpm docs:build   # regenerate docs/ from SPEC.md + README.md
```

Per-package work (turbo filters, package names are `@greatcms/<dir>`):

```sh
pnpm --filter @greatcms/spec test
pnpm --filter @greatcms/studio exec vitest run tests/media.test.ts   # one file
pnpm --filter @greatcms/studio exec vitest run -t "rejects svg"      # one test
```

Every package's `vitest.config.ts` re-exports `vitest.shared.ts`: a 30 s test
timeout and half the cores per package, because turbo runs several at once.
Change timeouts and worker counts there, not per file.

`test` depends on `build`, so after changing a package that another one imports,
run `pnpm build` before the dependent's tests — invoking `vitest` directly skips
that. Vitest watch mode is not wired into turbo — run
`pnpm --filter <pkg> exec vitest` directly.

Running things:

```sh
STUDIO_PASSWORD='something long' pnpm dev        # studio (:8787) + Astro example (:4321)
STUDIO_PASSWORD='something long' pnpm studio     # the studio alone
pnpm --filter @greatcms/docs dev
pnpm --filter @greatcms/example-business-astro dev
pnpm greatcms check                              # any CLI command, from this checkout
```

Browser tests (ProseMirror, live preview, colour contrast) need Chromium once:

```sh
pnpm --filter @greatcms/studio exec playwright install chromium
```

Without it they skip rather than fail — a green run on a fresh checkout has not
proven the client side.

Cross-language conformance (CI runs this every build):

```sh
python3 examples/reader-python/read.py packages/conformance/fixtures /tmp/out
node packages/conformance/bin/greatcms-conformance.mjs verify /tmp/out
```

## Architecture

The product is the **file standard** in `SPEC.md`: `.cms/schema.yaml`,
`.cms/config.yaml`, and JSON/Markdown content files in the repository. Every
package is an implementation of that document; if they disagree, the code is
wrong.

**`packages/spec`** is the single source of truth for the format in TypeScript —
schema parsing (`schema.ts`), config (`config.ts`), field types and defaults
(`fields.ts`), content parsing/serializing (`content.ts`), validation
(`validate.ts`), and path resolution (`paths.ts`). It is a convenience, not a
requirement: it holds no I/O, so both the reader and the studio depend on it for
the same resolution rules. Field types and their storage shapes live in
`fields.ts` — adding a field type means touching that, `validate.ts`, the
studio's `views/fields.ts` renderer, and `SPEC.md`.

**Resolution** is the concept that ties the halves together: a schema region plus
an optional content file resolves to a document, with schema defaults filling
anything missing (`resolveRegion`). A missing content file is normal; a missing
schema is fatal.

**`packages/reader`** is the build-time consumer — synchronous `node:fs` reads,
no framework code. `vite.ts` exports `greatcmsWatch()`, needed because
filesystem reads are invisible to Vite's dependency graph.

**`apps/studio`** is a Hono server, server-rendered, every mutation a form POST.
The layering:

- `main.ts` wires env → `Store` (SQLite via `node:sqlite`) → `createApp`.
- `app.ts` is the whole HTTP surface: auth, site CRUD, the editor, publish,
  media upload, form intake, inbox.
- `repo.ts` defines `Repository` — read a file, list a directory, read the head,
  commit a set of files — with `LocalRepository` as the only implementation.
  **Adding a backend means implementing that interface, not branching in
  `app.ts`.** Everything above this line is backend-agnostic.
- `sites.ts` (`SiteClient`) sits on `Repository` and speaks in schema/config/
  regions/collections rather than files.
- `views/` renders HTML: `pages.ts` (screens), `fields.ts` (one renderer per
  field type, plus error attachment), `layout.ts`.
- `client/*.ts` is the only browser JavaScript (ProseMirror editor + live
  preview). tsdown builds it to `public/*.js` in the same `pnpm build`; those
  files are build output, and are loaded only on screens with a richtext field.

**`packages/cli`** is `greatcms init` (framework detection in `detect.ts`,
scaffolding in `init.ts`), `add` (edits an existing schema as text, preserving
its comments), `types` (TypeScript from the schema), `check`, and `doctor`.

**`packages/deploy`** is `greatcms-deploy`, the one piece that runs a site's own
code: it clones a commit into a work folder, runs the build command, and swaps a
`current` symlink. It is a separate process and container from the studio on
purpose, so the studio's "never executes a managed repository" rule holds.

**`packages/conformance`** is fixtures plus a verifier; it defines what "reads
the standard correctly" means for any implementation in any language. The
fixtures deliberately include the awkward cases — missing content file, content
predating a schema field, block missing a defaulted field, decorative empty alt.

**`docs/`** is generated by `scripts/gen-agent-docs.mjs` from `SPEC.md` and
`README.md`. Never edit it by hand; CI fails on drift.

## Conventions

- Comments are deliberately sparse: a one-line file docstring, and a single line
  where the code cannot say it itself. Do not reintroduce block essays. Prefer a
  regression test over a comment about a bug.
- Tooling is Rust-first (oxlint, oxfmt, tsdown, Vite 8 (Rolldown)). Do not
  reintroduce ESLint, Prettier, or plain Rollup. `pnpm lint:fix` and
  `pnpm format` fix mechanically.
- ESM only, `.js` extensions in relative imports, pnpm. Developing needs Node >= 22.18
  (tsdown, jsdom); the studio runs on >= 22.13 (`node:sqlite`); published packages
  still target Node 20.
- Changing the standard means bumping `version:` in the spec and documenting a
  migration; new optional keys and field types are additive within version 1.

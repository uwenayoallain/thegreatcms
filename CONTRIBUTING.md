# Contributing

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

Working on GreatCMS itself. Read [AGENTS.md](./AGENTS.md) first: it lists the
design decisions that look like bugs but are not, and must not be "fixed".
[DESIGN.md](./DESIGN.md) explains why they are there.

## Setup

Node 22.18 or newer (`.node-version` says so) and pnpm.

```sh
pnpm install
pnpm check      # the gate CI runs: oxlint, oxfmt --check, docs:check, typecheck, test
```

Browser tests (ProseMirror, live preview, colour contrast) need Chromium once.
Without it they skip rather than fail, so a green run on a fresh checkout has
not proven the client side:

```sh
pnpm --filter @greatcms/studio exec playwright install chromium
```

## Running things

```sh
pnpm dev                                       # the studio and every example site, connected
STUDIO_PASSWORD='something long' pnpm studio   # the studio alone, on :8787
pnpm greatcms check                            # any CLI command, from this checkout
pnpm --filter @greatcms/docs dev               # the website
```

`pnpm dev` opens the studio at http://localhost:8787 (password `greatcms-dev`)
with every example connected and rendering beside the form. It rebuilds on
change and keeps you signed in across restarts.

Tests import each package's `dist/`, so `pnpm test` builds first. After changing
a package another one imports, run `pnpm build` before calling `vitest`
directly. One file or one test:

```sh
pnpm --filter @greatcms/studio exec vitest run tests/media.test.ts
pnpm --filter @greatcms/studio exec vitest run -t "rejects svg"
```

Cross-language conformance, which CI also runs:

```sh
python3 examples/reader-python/read.py packages/conformance/fixtures /tmp/out
node packages/conformance/bin/greatcms-conformance.mjs verify /tmp/out
```

## Layout

```
SPEC.md                 The standard. Every package implements it; if they disagree, the code is wrong
packages/spec/          The standard in TypeScript: schema, config, fields, validation, paths
packages/reader/        Build-time reader, plus the Astro integration and Vite watcher
packages/cli/           The greatcms command
packages/conformance/   Fixtures and the verifier any implementation must pass
packages/deploy/        Clones, builds and swaps releases: the one piece that runs site code
apps/studio/            The CMS: a Hono server, server-rendered, every mutation a form POST
apps/docs/              The website, itself managed by GreatCMS
examples/               Six sites on Astro, Next.js, SvelteKit and Nuxt, and a Python reader
skills/greatcms/        An installable skill for agents working inside a site
docs/                   Generated agent docs; never edit by hand
```

[CLAUDE.md](./CLAUDE.md) walks through how the studio's modules fit together.

## Conventions

- **Rust tooling first:** oxlint, oxfmt, tsdown and Vite 8 (Rolldown), with
  Turborepo for the task graph and Vitest for tests. Don't bring back ESLint,
  Prettier or plain Rollup. `pnpm lint:fix` and `pnpm format` fix things
  mechanically.
- **ESM only:** `.js` extensions in relative imports. Published packages target
  Node 20, and the studio needs Node 22.13 for `node:sqlite`.
- **Sparse comments:** a one-line docstring per file, and a single line where the
  code can't say it. Prefer a regression test to a comment about a bug.
- **Generated docs:** `docs/`, `llms.txt` and `docs.json` are built from
  `SPEC.md`, `README.md` and the docs collection. Run `pnpm docs:build` after
  changing those, or CI fails on the drift.
- **Changing the standard** means bumping `version:` in the spec and documenting a
  migration. New optional keys and field types are additive within version 1.

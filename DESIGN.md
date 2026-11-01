# Design decisions

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

Why GreatCMS works the way it does. [AGENTS.md](./AGENTS.md) lists the same
decisions as rules for anyone changing the code.

## The format

**Content is JSON; prose is Markdown.** Every language parses JSON with no
dependencies, and every static site generator already has a Markdown pipeline.
One format for both would have fought one of those two facts.

**Rich text is sanitized HTML, with the editor AST beside it.** A consumer that
just wants to print a paragraph needs no library. `_ast` is there for anyone who
wants structural control, and is safe to ignore.

**Alt text is structurally required.** The only way to store an empty `alt` is a
field marked `alt: decorative-allowed`, which makes an inaccessible image a
deliberate act rather than an oversight.

**A missing content file is never an error.** It resolves to schema defaults, so
a site is correct before the CMS has ever been opened. A missing _schema_ is an
error: failing loudly beats quietly rendering empty regions.

## The studio

**A site is a folder on this machine.** The studio reads and writes the working
copy directly: no token, no network, no push unless you turn it on. There was a
hosted-repository backend once, and it made every screen ask which of two worlds
it was in. The studio needs four operations from a repository (read a file, list
a directory, read the head commit, commit a set of files), so another backend
means implementing that interface, not branching through the app.

**Publishing is one commit.** Every file a publish touches is written before
anything is staged, so a region and the images it references land together or
not at all. A working copy that moved while you were editing gets a 409 rather
than an overwrite.

**The studio never runs your code.** It reads your schema and writes content,
and it never runs your Git hooks. Previews render in your own dev server, which
is also why one studio can manage several sites without carrying a toolchain
for each. Building the site is `greatcms-deploy`'s job, in its own process.

**The admin is plain HTML first.** Every mutation is a form POST, including
adding, removing and reordering blocks, so the studio is keyboard- and
screen-reader-navigable by construction. Rich text gets a ProseMirror editor
over a real textarea, loaded only on screens that need it. If the script never
loads, you can still edit and publish.

**Forms need nothing on the site.** A plain HTML `<form>` posting to the studio
is the whole integration. Spam is scored with a honeypot, submission timing and
a rate limit rather than a CAPTCHA, which taxes every legitimate visitor to
inconvenience a bot that solves it anyway.

## What the tests hold it to

Each of these is an automated test, run in CI on every push.

- **Another language reads it.** A Python reader written from `SPEC.md` alone
  passes the conformance suite: `examples/reader-python`.
- **The awkward cases are covered.** The fixtures include a region with no
  content file, content older than a schema field, a block missing a defaulted
  field, and a decorative image with empty alt text.
- **Sites ship nothing to the browser.** The built example sites and the docs
  site contain no `<script>` tags, and each has a weight budget its tests assert.
- **It is accessible.** axe runs against every page of the example sites and
  every screen of the studio. Colour contrast is judged in Chromium, against
  real layout.
- **The visual editor works in a browser.** Chromium checks that ProseMirror
  mounts, the toolbar applies marks, and the preview updates without
  committing, and that with JavaScript off the same screen still publishes.
- **Content matches its schema.** `greatcms check` and `greatcms types --check`
  run against this repository's own sites.

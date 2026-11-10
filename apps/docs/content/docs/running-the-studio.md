---
title: Running the studio
summary: One process, one SQLite file, one password. Nothing it manages depends on it.
order: 35
---

The studio is a single Node process. It keeps its own state, the list of sites
and the submissions inbox, in one SQLite file, and reads and writes the sites it
manages as folders on the same machine.

```sh
STUDIO_PASSWORD='something long' pnpm --filter @greatcms/studio start
# GreatCMS studio on http://localhost:8787
```

Or as a container, from the published image. Mount the folder that holds your
sites, since the studio edits them in place, and a volume for its database:

```sh
docker run -p 8787:8787 -e STUDIO_PASSWORD='something long' \
  -v greatcms-data:/data -v ~/sites:/sites \
  ghcr.io/uwenayoallain/greatcms-studio
```

Then connect `/sites/my-site` in the studio. `apps/studio/Dockerfile` builds
the same image from a checkout. `STUDIO_PASSWORD` is required and deliberately
has no default.
For a server that also builds and serves the site, see
[Self-hosting](/docs/self-hosting/).

## Environment

| Variable                 | Meaning                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `STUDIO_PASSWORD`        | Required. Changing it signs every open session out.                                                              |
| `STUDIO_SECRET`          | Signs session cookies. Generated on start if unset, which means sessions reset on restart.                       |
| `STUDIO_DB`              | Path to the SQLite file. Defaults to `data/studio.sqlite`.                                                       |
| `PORT`                   | Defaults to `8787`.                                                                                              |
| `STUDIO_SITES`           | Sites to manage from the first start, as JSON; see [Self-hosting](/docs/self-hosting/).                          |
| `STUDIO_URL`             | Where browsers reach the studio, so a proxy's `forward_auth` can send visitors here to sign in.                  |
| `STUDIO_COOKIE_DOMAIN`   | Parent domain the preview's sign-in cookie covers, e.g. for `preview.`; see [Self-hosting](/docs/self-hosting/). |
| `STUDIO_TRUST_PROXY`     | `1` behind a reverse proxy you control, `cloudflare` behind Cloudflare. Unset when reachable directly.           |
| `RESEND_API_KEY`         | With `NOTIFY_FROM` and `NOTIFY_TO`, emails each form submission. Without them, submissions are only stored.      |
| `STUDIO_WEBHOOK_URL`     | Posts every submission and every publish as JSON to this `http(s)` URL. Slack and Discord webhooks work as is.   |
| `STUDIO_SUBMISSION_DAYS` | Deletes submissions older than this many days. Unset: they are kept.                                             |
| `STUDIO_TIMEZONE`        | The zone "Publish later" times are typed and shown in, e.g. `Africa/Kigali`. Defaults to the server's.           |
| `STUDIO_SITES_ROOT`      | The folder of sites the connect page lists, and where copies go.                                                 |
| `STUDIO_CLONE_PRIVATE`   | `1` lets Copy from Git reach this machine and its private network, for a Git server that lives there.            |

Behind a proxy, `STUDIO_TRUST_PROXY` lets rate limiting see the visitor's
address rather than the proxy's, and marks the session cookie `Secure`. The
studio uses the last `X-Forwarded-For` entry, the one your proxy appended, or
`CF-Connecting-IP` for Cloudflare. Leave it unset when the studio is reachable
directly: those headers are then the visitor's to forge.

## Connecting a site

A site is a folder on the machine the studio runs on. **Connect a site** finds
one three ways:

- **In the sites folder.** With `STUDIO_SITES_ROOT` set, the page lists the
  folders in it. One with a schema connects with a click, named after its
  folder; one without offers **Set up**.
- **From GitHub.** Connect GitHub once on **Git access**: the studio makes
  its own GitHub App, you choose the repositories it may use, and each copies
  with a click, signing in with a token that lasts an hour.
- **Copy from Git.** Paste any https or SSH address, without a token in it:
  for a private repository, save one on **Git access**. Only files are
  fetched: no hooks, submodules or redirects. Two copies run at a time, each
  up to 2 GB.
- **By path.** Any other folder; `~` is the studio user's home.

The studio reads `.cms/schema.yaml` from that working copy and builds the
editor from it. There is no token and no network call. Give it your dev
server's URL and the editor frames your real site beside the form; see
[Previewing](/docs/previewing/). With `STUDIO_PREVIEW_URL` set, a site
connected without one gets its own; see [Self-hosting](/docs/self-hosting/).

A folder with no schema gets **Set up**: pick a `greatcms init` starter, and
the studio commits `.cms/schema.yaml` and `.cms/config.yaml` and connects the
site, changing nothing else.

A new **Branch** in a site's settings keeps publishes off the live one, to
review and merge on GitHub.

## People

The owner signs in with `STUDIO_PASSWORD` and leaves the email empty. From
**Editors** in the sidebar the owner adds people by name, email and a password
of at least twelve characters. Each signs in as themselves, and each publish
is committed under their name and address, so `git log` says who changed what.

Sites and people stay the owner's: an editor cannot connect, reconfigure or
disconnect a site, or manage editors. An editor reads the body of an MDX
entry but cannot change it: MDX is code the site's build runs, so whatever an
editor posts for it, the stored source is kept. Removing someone signs them out on their
next request. When two people have the same content open, each sees the
other's name; if both publish, the second is refused rather than overwriting
the first.

## Working on content

- **Search.** The box at the top of a site's sidebar finds words in every
  region and entry, unpublished drafts included, and opens the field that holds
  them. Press `/` to jump to it.
- **History.** Every region and entry has a History link listing the commits
  that changed it. Restoring a version opens it in the editor as an unsaved
  edit, so you see it in the preview and publish it back as one new commit.
- **Publish later.** Beside Publish, pick a time and Schedule. The form is
  kept as submitted and published at that time through the ordinary publish,
  as the person who scheduled it. If the content was changed by someone else
  in the meantime it is not overwritten; the site page lists what is waiting,
  what went out and what did not, and anything waiting can be cancelled.
- **Unsaved edits that went stale.** A draft remembers the commit it began
  from. If the same content was published since, the editor says so and a
  publish of the old draft is refused.
- **Images already on the site** are offered in every image field, so one
  upload can be used again. Reference fields offer the entries they can point at.
- **Ctrl or Cmd with Enter** publishes.

## What it will not do

The studio never executes anything from a repository it manages: not a build,
not a Git hook, not a schema that happens to be code. Schemas are data. A
preview is your own dev server. Checks belong in CI, where they run on every
commit anyway.

Shut the studio down and every site it managed keeps building from what is in
Git. That is the point of the whole arrangement, and it is why one studio can
manage several sites without carrying a toolchain for each.

## Security headers and rate limits

Every response carries a strict `Content-Security-Policy`, and a preview URL
the browser would execute (`javascript:`, `data:`) is refused. Sign-in attempts
and form intake are rate limited per address, and uploads are checked by their
bytes rather than their extension: an SVG, which can carry script, is refused as
an image.

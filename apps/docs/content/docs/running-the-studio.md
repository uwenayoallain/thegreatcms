---
title: Running the studio
summary: One process, one SQLite file, one password. Nothing it manages depends on it.
order: 35
---

The studio is a single Node process. It keeps its own state, the list of sites
and the submissions inbox, in one SQLite file, and reads and writes the sites it
manages as folders on the same machine. Hosted or local, it is open source
under the MIT licence, and anyone may run their own.

## On your own machine

In a site's folder, one command opens the editor for it:

```sh
npx greatcms studio
```

It starts the studio on `127.0.0.1:4983`, or the next free port, with this
folder as its one site, and opens it in your browser with no sign-in. The
live preview is the site's dev server: the one already running, or your own
dev command, started here and stopped with it.
Publishing commits to the working copy as you; nothing is pushed. This
studio is for that one project: it has no list of sites, nothing to connect
or disconnect, and no editors to add.

It trusts whoever can reach it on this machine, other users of a shared one
included, which is why it only listens on loopback. `--host` with any other
address is refused unless `STUDIO_PASSWORD` is set, and then you sign in
with that instead.

| Option            | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `--port <number>` | The studio's port, exactly; an error if it is taken. |
| `--dev-url <url>` | Use this dev server and start none.                  |
| `--no-dev`        | Edit without a preview.                              |
| `--no-open`       | Print the address without opening a browser.         |

It needs Node.js 22.13 or newer and the `@greatcms/studio` package, which the
command offers to add to the site the first time, showing the exact install
command and asking before it runs. Its database and session secret go in
`node_modules/.cache/greatcms`, or your user cache folder when the site has no
`node_modules`: never in a file Git tracks. Ctrl+C stops everything.

## On a server

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
| `STUDIO_TIMEZONE`        | The zone times are shown in and "Publish later" is typed in, e.g. `Africa/Kigali`. Defaults to the server's.     |
| `STUDIO_LOCALE`          | The language tag dates and times are written in, e.g. `en-GB` or `fr`. Defaults to `en`.                         |
| `STUDIO_OWNER_NAME`      | What others see the password's owner called. Defaults to `Owner`.                                                |
| `STUDIO_SITES_ROOT`      | The folder of sites the connect page lists, and where copies go.                                                 |
| `STUDIO_CLONE_PRIVATE`   | `1` lets Copy from Git reach this machine and its private network, for a Git server that lives there.            |
| `STUDIO_GITHUB_OWNERS`   | GitHub logins, comma-separated, that are owners when they sign in. Unset: the person who owns the GitHub App.    |
| `STUDIO_GITHUB_URL`      | A GitHub Enterprise Server address, when that is your GitHub. Defaults to `https://github.com`.                  |

Behind a proxy, `STUDIO_TRUST_PROXY` lets rate limiting see the visitor's
address rather than the proxy's, and marks the session cookie `Secure`. The
studio uses the last `X-Forwarded-For` entry, the one your proxy appended, or
`CF-Connecting-IP` for Cloudflare. Leave it unset when the studio is reachable
directly: those headers are then the visitor's to forge.

## Connecting a site

A site is a folder on the machine the studio runs on. **Connect a site** finds
one three ways:

- **From GitHub.** Connect GitHub once: the studio makes its own GitHub App
  and you choose the repositories it may use. They are listed with the ones
  that already use GreatCMS first; tick any number and **Add selected**
  copies each, signing in with a token that lasts an hour. One with a schema
  is connected as it lands; any other offers **Set up**.
- **In the sites folder.** With `STUDIO_SITES_ROOT` set, the page lists the
  folders in it. One with a schema connects with a click, named after its
  folder; one without offers **Set up**.
- **Copy from Git.** Paste any https or SSH address, without a token in it:
  for a private repository, save one on **Git access**. Only files are
  fetched: no hooks, submodules or redirects. The host is looked up once and
  the copy held to that address, so a name cannot answer differently the second
  time. Two copies run at a time, each up to 2 GB, made beside the database
  where no site's code can write and moved into the sites folder when whole.
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
An editor opens only the sites the owner ticks for them there, or every site
if that box is ticked; one added before this choice existed keeps every site.

Sites and people stay the owner's: an editor cannot connect, reconfigure or
disconnect a site, or manage editors, and reads an MDX entry's body without
changing it, because MDX is code the site's build runs. Removing someone signs
them out on their next request. Two people with the same content open see each
other's name; if both publish, the second is refused, not overwritten.

### Sign in with GitHub

A new studio is opened once with `STUDIO_PASSWORD`, which leads straight to
connecting GitHub. From then on the sign-in page is **Continue with GitHub**,
with the password behind a link for the owner and for editors given one.
Whoever GitHub lets push to a connected site's
repository edits that site and sees no other: its content, images, history,
search and inbox.

- The studio asks GitHub who may push, believes the answer for under two
  minutes, and asks again on every publish. Access removed on GitHub ends here.
- It asks for no email and keeps no token. Commits are authored as
  `id+login@users.noreply.github.com`.
- Signing in never connects a repository. Someone who can push to none of the
  connected sites sees a page saying so.
- The person who owns the GitHub App is an owner; `STUDIO_GITHUB_OWNERS` names
  others instead. Disconnecting GitHub signs all of them out.

Search, history, scheduled publishes and the rest of a day's editing are in
[Managing content](/docs/managing-content/).

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

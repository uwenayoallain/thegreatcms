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

Or as a container: `apps/studio/Dockerfile` builds one image with one volume
for the database. `STUDIO_PASSWORD` is required and deliberately has no default.
For a server that also builds and serves the site, see
[Self-hosting](/docs/self-hosting/).

## Environment

| Variable               | Meaning                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `STUDIO_PASSWORD`      | Required. Changing it signs every open session out.                                                         |
| `STUDIO_SECRET`        | Signs session cookies. Generated on start if unset, which means sessions reset on restart.                  |
| `STUDIO_DB`            | Path to the SQLite file. Defaults to `data/studio.sqlite`.                                                  |
| `PORT`                 | Defaults to `8787`.                                                                                         |
| `STUDIO_SITES`         | Sites to manage from the first start, as JSON; see [Self-hosting](/docs/self-hosting/).                     |
| `STUDIO_URL`           | Where browsers reach the studio, so a proxy's `forward_auth` can send visitors here to sign in.             |
| `STUDIO_COOKIE_DOMAIN` | Parent domain the sign-in is shared across, e.g. for `preview.`; see [Self-hosting](/docs/self-hosting/).   |
| `STUDIO_TRUST_PROXY`   | `1` behind a reverse proxy you control, `cloudflare` behind Cloudflare. Unset when reachable directly.      |
| `RESEND_API_KEY`       | With `NOTIFY_FROM` and `NOTIFY_TO`, emails each form submission. Without them, submissions are only stored. |

Behind a proxy, `STUDIO_TRUST_PROXY` lets rate limiting see the visitor's
address rather than the proxy's, and marks the session cookie `Secure`. The
studio uses the last `X-Forwarded-For` entry, the one your proxy appended, or
`CF-Connecting-IP` for Cloudflare. Leave it unset when the studio is reachable
directly: those headers are then the visitor's to forge.

## Connecting a site

A site is a folder on the machine the studio runs on. Add it by path, and the
studio reads `.cms/schema.yaml` from that working copy and builds the editor
from it. There is no token and no network call. Give it your dev server's URL
and the editor frames your real site beside the form; see
[Previewing](/docs/previewing/).

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

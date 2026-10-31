---
title: Self-hosting
summary: One server, three containers; an editor publishes and the site is live in seconds.
order: 37
---

Nothing here needs a platform. A site built with GreatCMS is files, so the whole
of it, editing included, fits on one small server:

- **The studio**, where editors sign in and publish. Each publish is a commit in
  the site's working copy on that server.
- **The builder**, `greatcms-deploy`, which watches that working copy, builds
  every new commit in a clean checkout, and swaps the live folder when the build
  succeeds. A failed build changes nothing; the previous release stays up.
- **A web server** serving the live folder, with the studio behind the same
  reverse proxy. Caddy gets HTTPS for free.

Editors never touch Git, a terminal, or a dashboard. Publish, wait a few
seconds, reload.

## The builder

```sh
DEPLOY_SOURCE=/srv/sites/my-site DEPLOY_ROOT=/srv/www npx greatcms-deploy
```

It checks the branch tip every few seconds. For a commit that is not live it
clones the repository into a work folder, runs the build command (by default
`pnpm install --frozen-lockfile && pnpm build`), moves the output into
`releases/<sha>`, and repoints the `current` symlink in one rename. Serve
`DEPLOY_ROOT/current` and a visitor always sees a whole release, never a
half-written one. The last few releases are kept so you can roll back by moving
the symlink.

| Variable          | Meaning                                                         |
| ----------------- | --------------------------------------------------------------- |
| `DEPLOY_SOURCE`   | The repository: a path on the server, or any URL git can clone. |
| `DEPLOY_ROOT`     | Holds `releases/`, `current` and `status.json`.                 |
| `DEPLOY_BUILD`    | The build command. Runs in the checkout with `CI=1`.            |
| `DEPLOY_OUTPUT`   | The folder the build writes, relative to the checkout. `dist`.  |
| `DEPLOY_BRANCH`   | `main`.                                                         |
| `DEPLOY_INTERVAL` | Seconds between checks. `10`.                                   |
| `DEPLOY_KEEP`     | Releases kept for rollback. `5`.                                |

`status.json` records what is live and, until a later commit builds, the newest
one that failed with the tail of its build log. `greatcms-deploy status` prints
it; `greatcms-deploy once` builds and exits, for a cron job or a CI step.

The builder is the only part of the arrangement that runs the site's own code,
and it does so in a container of its own with nothing but a clone in it. The
studio still executes nothing from a repository it manages; see
[Running the studio](/docs/running-the-studio/).

## Declaring sites up front

A server should come up already managing its sites, under ids that do not
change between restarts, because the id is part of the form address every
contact form posts to. `STUDIO_SITES` does that:

```sh
STUDIO_SITES='[{"id":"my-site","path":"/srv/sites/my-site","devUrl":"https://preview.example.com","deployRoot":"/srv/www","pushAfterPublish":false}]'
```

`deployRoot` is the builder's `DEPLOY_ROOT` as the studio sees it; mount the
same volume into both. With it, the site page shows what is live, a build that
failed with its log, and the releases kept on disk. **Put this back live**
asks the builder to swap to one of them by writing its commit into a
`rollback` file there; the studio still runs nothing of the site's. The
rolled-back release stays live until the next publish, which goes out as usual.

On start the studio adds any site it does not have and brings the rest in line
with the list. An id that already points at a different folder is refused
rather than silently moved.

## Images

Both servers are published as images on every release, so a server needs no
GreatCMS checkout:

```
ghcr.io/uwenayoallain/greatcms-studio
ghcr.io/uwenayoallain/greatcms-deploy      # also runs greatcms-preview
```

Each is about 70 MB: Node on Alpine, git, and the program. The studio's server
is one bundled file with no `node_modules`.

## Sharing the preview

The link icon above the editor's preview makes a link anyone can open for
seven days, unpublished edits included, without a studio account. It works
through the same `forward_auth` check: the link carries a signed token, the
studio trades it for a cookie that opens that site's preview and nothing else,
and changing `STUDIO_PASSWORD` revokes every link at once.

## Live preview on the server

The editor frames the site's dev server beside the form, so a change is seen
rendered before it is published. On a server that means running the dev server
there too, in the same working copy the studio writes drafts into, and it must
not be open to the world.

The studio vouches for it. `GET /auth/check` answers `204` when the request
carries a signed-in session and otherwise redirects to the studio's sign-in,
which comes back to the page that was wanted. Caddy's `forward_auth` asks it
before every preview request:

```
preview.example.com {
	forward_auth studio:8787 {
		uri /auth/check
	}
	reverse_proxy preview:4321
}
```

The studio's own session cookie never leaves the studio's host, because the
preview runs the site's code and would otherwise receive it. Signing in also
sets a second cookie for the parent domain that opens the preview and nothing
else. For that, the studio has to know the domain and its own address:

| Variable               | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `STUDIO_URL`           | Where browsers reach the studio, `https://studio.example.com`. |
| `STUDIO_COOKIE_DOMAIN` | The parent domain, `example.com`. Unset: this host only.       |

A redirect is only ever issued to a host under that domain. With both set, an
editor who is signed in to the studio sees the preview, in the frame and in a
tab, and nobody else does. There is no second password. The dev server itself
has to accept the name it is reached by; the example passes `PREVIEW_HOST` to
Astro's `vite.server.allowedHosts`.

The preview is optional: without it the editor still publishes, and the
builder shows the result a few seconds later.

The studio says when a dev server is not running: on the sites list, on the
site's page, and over the editor's preview, instead of framing an error page.
It checks by connecting to the dev server, so it needs an address it can reach
itself. When browsers reach the preview somewhere else, through the proxy
above, give the site a `probeUrl` in `STUDIO_SITES` naming the dev server
directly:

```json
[
  {
    "id": "irona",
    "path": "/srv/sites/irona",
    "devUrl": "https://irona-preview.example.com",
    "probeUrl": "http://preview:4321"
  }
]
```

### Only while someone is editing

A dev server is the one heavy process in the stack, and it is only useful
while an editor is looking. `greatcms-preview`, in the same package and image
as the builder, stands where the dev server would: the first request starts
it, every request keeps it alive, and after `PREVIEW_IDLE` seconds of silence
(fifteen minutes by default) it is stopped. While it comes up the browser gets
a small page that asks again every two seconds, so the editor's frame fills in
by itself.

| Variable          | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `PREVIEW_SOURCE`  | The site's working copy, the same folder the studio writes drafts to. |
| `PREVIEW_COMMAND` | Starts the dev server on `$PORT`; default installs and runs Astro.    |
| `PREVIEW_IDLE`    | Seconds without a request before it is stopped.                       |

`GET /__greatcms/preview` reports whether it is stopped, starting or running.
Reloads reach the dev server over the same proxy, WebSockets included, so a
draft still shows as you type. The example stack runs it this way, and a
site that nobody edits all day costs a few megabytes of the proxy and nothing
else.

## Behind a Cloudflare Tunnel

A studio on a machine with no public address, or with no ports you want open,
can be reached through a Cloudflare Tunnel instead of a reverse proxy.
`apps/studio/tunnel/` runs the studio beside `cloudflared`, and the studio's
port is never published, so the tunnel is the only way in:

```sh
cd apps/studio/tunnel
cp .env.example .env    # the tunnel token, STUDIO_HOST, a password, the sites
docker compose up -d --build
```

Create the tunnel in Cloudflare and give it one public hostname,
`studio.example.com`, pointing at `http://studio:8787`. Cloudflare terminates
TLS and tells the studio so, which keeps its cookies `Secure`; the compose file
sets `STUDIO_TRUST_PROXY=cloudflare`, so rate limiting sees each visitor's own
address. `SITES_DIR` is mounted at the same path inside the container, so the
paths in `STUDIO_SITES` are the ones on the host.

The preview a site's `devUrl` names is framed by the editor's browser, not by
the server, so a `localhost` address works only on the machine running the dev
server. The same compose file also runs the previews for editors anywhere:

- `previews` runs every site's dev server, inside the compose network only.
- `caddy` sits in front of them and asks the studio's `/auth/check` about each
  visitor, so a preview opens for someone signed in to the studio and for
  nobody else.
- Set `PREVIEW_DOMAIN=example.com`, and site `my-site` previews at
  `my-site-preview.example.com`. Give the tunnel one public hostname per
  preview, pointing at `http://caddy:80`.

Each site in `STUDIO_SITES` then names both addresses: `devUrl` is
`https://my-site-preview.example.com`, for browsers, and `probeUrl` is
`http://previews:4322`, where the studio checks that the dev server is running.
Signing in sets the preview cookie for `PREVIEW_DOMAIN` too, and the cookie
opens the previews and nothing else.

## A complete example

`examples/studio-astro/deploy/` holds a `compose.yaml` and `Caddyfile` that
run all of this on one machine from one setting. `DOMAIN=example.com` in
`.env` gives the site at the apex and `www`, the studio at `studio.example.com`
and the preview at `preview.example.com`, with Caddy on 80 and 443 fetching
certificates for all four. Clone the site into `/srv/sites`, point the four
DNS records at the server, and `COMPOSE_BAKE=false docker compose up -d --build`
(the images build on the host network, which the bake builder refuses). The same files
with `compose.local.yaml` run everything on `localhost` ports first; browsers
share cookies across ports, so the sign-in covers the preview there too.

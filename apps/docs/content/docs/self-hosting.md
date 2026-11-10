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

## What runs a site's code

The builder and the preview service run the site's build, its dev server and
its packages' install scripts; the studio
[runs none of it](/docs/running-the-studio/). Both compose files give each a
container and a network of its own, out of reach of the studio and the tunnel,
and every container a read-only root, no capabilities, and memory and process
limits. `docker compose up -d` alone restores a stopped stack. What that costs:

- Dev servers keep caches and `node_modules` in the site's folder, so previews
  mount it read-write, and sites in one preview service can reach each other:
  run one service per group of sites that trust each other.
- A dev server sees `PATH`, `HOME`, public names such as `PUBLIC_*` and
  `VITE_*`, and what `PREVIEW_ENV` lists: never the service's other variables,
  nor the studio's cookies.
- `PREVIEW_IGNORE_SCRIPTS=1` installs with `--ignore-scripts`; a package that
  compiles on install then fails.
- `PREVIEW_MAX_RUNNING` dev servers (six) run at once, the longest unused
  stopping for one more, and a failing one waits longer before each retry.
- A build whose output holds a link pointing outside it is not put live.
- That code can write the folder's `.git/config`, so the studio gives git a copy
  holding only remotes, branches and identity, and refuses to publish while the
  file names anything else. Git LFS, an SSH command or a credential helper go
  in the machine's own config (`git config --global`), which is the operator's
  and is used as it is. A remote that is a folder on the same machine is pushed
  to without its hooks; `greatcms studio` on your own checkout trusts its config.

## Declaring sites up front

Sites are usually connected in the studio. A server can also come up already
managing its sites, under ids that do not change between restarts, because
the id is part of the form address every contact form posts to.
`STUDIO_SITES` does that:

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

The studio's is Alpine, Node, git and one bundled file. The builder's is
Debian, for the native packages sites install.

## Sharing the preview

The link icon above the editor's preview makes a link anyone can open for
seven days, unpublished edits included, without a studio account. It works
through the same `forward_auth` check: the link carries a signed token, the
studio trades it for a cookie that opens that site's preview and nothing else.
**Stop sharing**, on the link's page and in site settings, ends that site's
links; changing `STUDIO_PASSWORD` ends every site's.

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
directly, such as `"probeUrl":"http://preview:4321"`.

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
Reloads pass through the same proxy, WebSockets included, so a draft still
shows as you type.

### Every site from one service

For many sites, run one `greatcms-preview` with `PREVIEW_SITES` naming the
list the studio writes to `STUDIO_PREVIEWS_FILE`. With
`STUDIO_PREVIEW_URL=https://{site}-preview.example.com`, a site connected
without a dev URL gets the next free name, and the service routes by host, so
one `*.example.com` block proxying to it covers every site.
`STUDIO_PREVIEW_PROBE` is where the studio checks the service is up.

Each dev server comes from the site's `package.json` (Astro, Next.js, Nuxt,
SvelteKit, Vite, or a `dev` script), installed first if needed.

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

- `previews` is the preview service above, serving every connected site's dev
  server inside the compose network only. It sets `GREATCMS_PREVIEW_SERVER=1`,
  so the Astro integration and the Nuxt module leave out the framework's dev
  toolbar, which costs round trips over a remote link.
- `caddy` sits in front of it and asks the studio's `/auth/check` about each
  visitor, so a preview opens for someone signed in to the studio and for
  nobody else.
- Set `PREVIEW_DOMAIN=example.com`, and a site connected from folder `my-site`
  previews at `my-site-preview.example.com`. Give the tunnel one wildcard
  hostname, `*.example.com` to `http://caddy:80`, after the studio's (or one
  hostname per preview, if other names must not reach the tunnel).

`SITES_DIR` is the sites folder the connect page lists and clones into;
`SITES_ROOT` names another when `SITES_DIR` is a single repository. Signing in
sets the preview cookie for `PREVIEW_DOMAIN` too, and it opens the previews
and nothing else.

### Bring your own domain

Anyone can run a studio of their own on their own domain, with this tunnel or
the server stack below. A studio hosts only the sites its owner connects:
signing in, with GitHub or a password, never adds one.

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

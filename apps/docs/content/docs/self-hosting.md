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
STUDIO_SITES='[{"id":"my-site","path":"/srv/sites/my-site","devUrl":"https://preview.example.com","pushAfterPublish":false}]'
```

On start the studio adds any site it does not have and brings the rest in line
with the list. An id that already points at a different folder is refused
rather than silently moved.

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

For the preview to see the same sign-in, the session cookie is set for the
parent domain, and the studio has to know its own address for the redirect:

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

## A complete example

`examples/business-astro/deploy/` holds a `compose.yaml` and `Caddyfile` that
run all of this on one machine from one setting. `DOMAIN=example.com` in
`.env` gives the site at the apex and `www`, the studio at `studio.example.com`
and the preview at `preview.example.com`, with Caddy on 80 and 443 fetching
certificates for all four. Clone the site into `/srv/sites`, point the four
DNS records at the server, and `COMPOSE_BAKE=false docker compose up -d --build`
(the images build on the host network, which the bake builder refuses). The same files
with `compose.local.yaml` run everything on `localhost` ports first; browsers
share cookies across ports, so the sign-in covers the preview there too.

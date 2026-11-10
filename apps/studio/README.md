# @greatcms/studio

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

The GreatCMS studio: the visual editor for sites whose content lives in their
own Git repository. One Node process, one SQLite file, no dependencies to
install. It needs Node.js 22.13 or newer.

It is open source under the [MIT licence](./LICENSE), like the rest of
GreatCMS, and made to be self-hosted: on your own machine for one project, or
on a server for several sites and people. Anyone may run their own.

## For the site in this folder

```sh
npx greatcms studio
```

That is the `greatcms` command from [`@greatcms/cli`](https://www.npmjs.com/package/@greatcms/cli),
which loads this package. It starts the studio on `127.0.0.1:4983` for the
project in the current folder and nothing else, signs your browser in through
a link that works once, and shows the site's dev server as the live preview.
There is no password: the studio answers only this machine, at its own address.

## On a server

```sh
STUDIO_PASSWORD='something long' npx greatcms-studio   # http://localhost:8787
```

Configured from the environment (`STUDIO_PASSWORD`, `STUDIO_DB`, `PORT`,
`STUDIO_SITES` and the rest). The same server ships as a container:

```sh
docker run -p 8787:8787 -e STUDIO_PASSWORD='something long' \
  -v greatcms-data:/data -v ~/sites:/sites ghcr.io/uwenayoallain/greatcms-studio
```

For a studio reachable from anywhere without opening a port, `tunnel/` in the
source holds a Docker Compose stack that puts it behind a Cloudflare Tunnel.

## From code

```js
import { startLocal } from "@greatcms/studio";

const studio = await startLocal({
  root: "/path/to/site", // the folder holding .cms/schema.yaml
  name: "My site",
  stateDir: "/path/to/site/node_modules/.cache/greatcms",
  port: 4983,
  devUrl: "http://localhost:4321",
});
console.log(studio.signInUrl); // signs one browser in, once
await studio.close();
```

`start(options)` is the same server without local mode: a password, any
number of sites, any address.

The studio never executes anything from a repository it manages, and a site
never depends on it at runtime.

Documentation: [Running the studio](https://github.com/uwenayoallain/thegreatcms/blob/main/apps/docs/content/docs/running-the-studio.md)
and [Self-hosting](https://github.com/uwenayoallain/thegreatcms/blob/main/apps/docs/content/docs/self-hosting.md)
· Source: https://github.com/uwenayoallain/thegreatcms

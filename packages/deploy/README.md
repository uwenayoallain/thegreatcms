# @greatcms/deploy

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

Two small servers for self-hosting a GreatCMS site next to its studio.

**`greatcms-deploy`** watches a repository, builds every new commit in a fresh
clone, and swaps a `current` symlink to the result. A failed build leaves the
previous release live. Serve `current` with any web server.

```sh
DEPLOY_SOURCE=/srv/sites/my-site DEPLOY_ROOT=/srv/www npx greatcms-deploy
```

**`greatcms-preview`** stands where the site's dev server would. The first
request from an editor starts the dev server, every request keeps it alive,
and after `PREVIEW_IDLE` seconds of silence it is stopped, so a site that
nobody is editing costs nothing.

```sh
PREVIEW_SOURCE=/srv/sites/my-site npx greatcms-preview
```

Both run as a separate process from the studio on purpose: the studio never
executes code from a repository it manages. Run either with `--help` for the
environment variables. A Dockerfile and a complete compose example are in the
repository.

Documentation: https://github.com/uwenayoallain/thegreatcms/blob/main/apps/docs/content/docs/self-hosting.md · Source: https://github.com/uwenayoallain/thegreatcms

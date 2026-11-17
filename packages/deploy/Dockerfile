# The builder: git, Node and pnpm, and nothing of the site until it clones it.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# Manifests alone first, so the install is reused until a dependency changes, not on every edit.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/deploy/package.json packages/deploy/
RUN pnpm install --frozen-lockfile --filter @greatcms/deploy...
COPY tsconfig.base.json ./
COPY packages/deploy ./packages/deploy
RUN pnpm --filter @greatcms/deploy build

# It has no dependencies of its own: the build output and two launchers are the whole program.
# Debian rather than Alpine: as the preview service it runs dev servers from node_modules that
# may have been installed on the host, whose native packages are built for glibc.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app/packages/deploy
COPY --from=build /app/packages/deploy/dist ./dist
COPY packages/deploy/bin ./bin
COPY packages/deploy/package.json ./
# /previews is the studio's list of sites. Both folders exist here so a volume first mounted by
# this image is still writable by the others that share it.
RUN mkdir -p /srv/www /previews && chown node:node /srv/www /previews
USER node
# pnpm's store, so repeated builds reinstall from cache rather than the network. HOME is named
# because a container run as another user id has no home of its own.
ENV HOME=/home/node PNPM_HOME=/home/node/.pnpm COREPACK_HOME=/home/node/.corepack \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# The pnpm this repository pins, in the image: a start needs no download, and gets no surprise.
RUN --mount=type=bind,source=package.json,target=/tmp/package.json \
  corepack install -g "$(node -p 'require("/tmp/package.json").packageManager')"
ENV DEPLOY_ROOT=/srv/www
VOLUME ["/srv/www"]
CMD ["node", "bin/greatcms-deploy.mjs"]

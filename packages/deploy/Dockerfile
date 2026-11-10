# syntax=docker/dockerfile:1
# The builder: git, Node and pnpm, and nothing of the site until it clones it.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# Manifests alone first, so the install is reused until a dependency changes, not on every edit.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/deploy/package.json packages/deploy/
RUN --mount=type=cache,id=greatcms-pnpm,target=/pnpm/store \
  --mount=type=cache,id=greatcms-corepack,target=/root/.cache/node/corepack \
  pnpm install --frozen-lockfile --filter @greatcms/deploy...
COPY tsconfig.base.json ./
COPY packages/deploy ./packages/deploy
RUN --mount=type=cache,id=greatcms-corepack,target=/root/.cache/node/corepack \
  pnpm --filter @greatcms/deploy build

# It has no dependencies of its own: the build output and two launchers are the whole program.
# Debian rather than Alpine: as the preview service it runs dev servers from node_modules that
# may have been installed on the host, whose native packages are built for glibc.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
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

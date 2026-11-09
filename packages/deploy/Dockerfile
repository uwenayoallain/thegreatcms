# The builder: git, Node and pnpm, and nothing of the site until it clones it.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @greatcms/deploy...
RUN pnpm --filter @greatcms/deploy... build

# It has no dependencies of its own: the build output and two launchers are the whole program.
# Debian rather than Alpine: as the preview service it runs dev servers from node_modules that
# may have been installed on the host, whose native packages are built for glibc.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app/packages/deploy
COPY --from=build /app/packages/deploy/dist ./dist
COPY --from=build /app/packages/deploy/bin ./bin
COPY --from=build /app/packages/deploy/package.json ./
RUN mkdir -p /srv/www && chown -R node:node /srv/www /app
USER node
# pnpm's store, so repeated builds reinstall from cache rather than the network.
ENV PNPM_HOME=/home/node/.pnpm COREPACK_HOME=/home/node/.corepack
ENV DEPLOY_ROOT=/srv/www
VOLUME ["/srv/www"]
CMD ["node", "bin/greatcms-deploy.mjs"]

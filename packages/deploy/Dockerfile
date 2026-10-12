# The builder: git, Node and pnpm, and nothing of the site until it clones it.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @greatcms/deploy...
RUN pnpm --filter @greatcms/deploy... build
# Reinstall without dev dependencies from the store already fetched, keeping the workspace layout
# so pnpm's relative links between packages still resolve once the tree is copied.
RUN CI=true pnpm install --prod --frozen-lockfile --offline --filter @greatcms/deploy...

FROM node:24-alpine
RUN apk add --no-cache git && corepack enable
WORKDIR /app
COPY --from=build /app ./
WORKDIR /app/packages/deploy
RUN mkdir -p /srv/www && chown -R node:node /srv/www /app
USER node
# pnpm's store, so repeated builds reinstall from cache rather than the network.
ENV PNPM_HOME=/home/node/.pnpm COREPACK_HOME=/home/node/.corepack
ENV DEPLOY_ROOT=/srv/www
VOLUME ["/srv/www"]
CMD ["node", "bin/greatcms-deploy.mjs"]

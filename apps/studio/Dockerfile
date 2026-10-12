# The studio is one Node process and one SQLite file. No database server, no
# native modules to compile, nothing to orchestrate.
FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/studio ./apps/studio

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @greatcms/studio... build
# Reinstall without dev dependencies from the store already fetched, keeping the workspace layout
# so pnpm's relative links between packages still resolve once the tree is copied.
RUN CI=true pnpm install --prod --frozen-lockfile --offline --filter @greatcms/studio...

FROM node:24-alpine
# Publishing is a git commit, and a push when the site asks for it.
RUN apk add --no-cache git openssh-client
WORKDIR /app

COPY --from=build /app ./
WORKDIR /app/apps/studio
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV STUDIO_DB=/data/studio.sqlite
ENV PORT=8787
# Site folders are mounted in, usually owned by another user; git must still be allowed to read them.
ENV GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*
EXPOSE 8787
VOLUME ["/data"]

# STUDIO_PASSWORD is required and deliberately has no default.
# STUDIO_SECRET keeps sessions alive across restarts.
CMD ["node", "--enable-source-maps", "dist/main.js"]

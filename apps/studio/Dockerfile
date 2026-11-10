# The studio is one Node process and one SQLite file. No database server, no
# native modules to compile, nothing to orchestrate.
#   docker build -t greatcms-studio -f apps/studio/Dockerfile .
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build

WORKDIR /app
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests alone first, so the install is reused until a dependency changes, not on every edit.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/spec/package.json packages/spec/
COPY packages/reader/package.json packages/reader/
COPY packages/cli/package.json packages/cli/
COPY packages/conformance/package.json packages/conformance/
COPY apps/studio/package.json apps/studio/
RUN pnpm install --frozen-lockfile --filter @greatcms/studio...

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/studio ./apps/studio
RUN pnpm --filter @greatcms/studio... build

# The server is one bundled file and the browser code a few more: no node_modules ship, and no
# package manager either, so the image is Alpine, the Node binary, git and the program.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
# Publishing is a git commit, and a push when the site asks for it.
RUN apk add --no-cache libstdc++ git openssh-client \
  && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app/apps/studio

COPY --from=build /app/apps/studio/dist ./dist
COPY --from=build /app/apps/studio/public ./public
# /previews holds the list of sites the preview service reads, written by the studio; /srv/www is
# the builder's folder. Both exist here so a volume first mounted by this image is still writable.
RUN mkdir -p /data /previews /srv/www && chown node:node /data /previews /srv/www
USER node

ENV STUDIO_DB=/data/studio.sqlite
ENV PORT=8787
# Site folders are mounted in, usually owned by another user; git must still be allowed to read them.
ENV GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://127.0.0.1:8787/sign-in || exit 1

# STUDIO_PASSWORD is required and deliberately has no default.
# STUDIO_SECRET keeps sessions alive across restarts.
CMD ["node", "--enable-source-maps", "dist/main.js"]

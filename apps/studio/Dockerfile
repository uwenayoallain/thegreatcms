# The studio is one Node process and one SQLite file. No database server, no
# native modules to compile, nothing to orchestrate.
FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages ./packages
COPY apps/studio ./apps/studio

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @greatcms/studio... build
RUN pnpm deploy --filter @greatcms/studio --prod /output

FROM node:24-alpine
WORKDIR /app

COPY --from=build /output ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV STUDIO_DB=/data/studio.sqlite
ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]

# STUDIO_PASSWORD is required and deliberately has no default.
# STUDIO_SECRET keeps sessions alive across restarts.
CMD ["node", "--enable-source-maps", "dist/main.js"]

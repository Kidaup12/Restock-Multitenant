# ws-gateway — build from the monorepo root:
#   docker build -f apps/ws-gateway/Dockerfile -t wezesha-ws-gateway .
#
# Multi-stage: install the workspace subtree, generate the Prisma client, run
# via tsx (already a production dependency) on node:22-alpine as a non-root
# user. Same pattern as the worker, for the same reason: session-backed socket
# auth pulls in @wezesha/db, and the Prisma query engine is a native binary
# resolved relative to the generated client — which rules out the single-file
# esbuild bundle the pre-auth gateway shipped.

FROM node:22-alpine AS build
WORKDIR /repo

# Workspace graph first, for layer caching: lockfile + only the manifests this
# service needs. npm ci -w prunes install to the service and its workspace deps.
COPY package.json package-lock.json ./
COPY apps/ws-gateway/package.json apps/ws-gateway/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/realtime/package.json packages/realtime/
# packages/db's postinstall is `prisma generate`, so the schema has to be in the
# image BEFORE the install — copying it with the rest of the source below is too
# late and fails the build.
COPY packages/db/prisma/ packages/db/prisma/
RUN npm ci -w @wezesha/ws-gateway

COPY packages/db/ packages/db/
COPY packages/observability/ packages/observability/
COPY packages/realtime/ packages/realtime/
COPY apps/ws-gateway/ apps/ws-gateway/

# Prisma CLI is a devDependency of @wezesha/db (not installed by the pruned
# ci); run it transiently to generate the client + linux-musl engine.
RUN npx --yes prisma@^6.1.0 generate --schema packages/db/prisma/schema.prisma

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build --chown=node:node /repo/ ./
USER node

# Railway injects PORT; the app defaults to 8081 when unset.
EXPOSE 8081

# HTTP liveness via the gateway's /healthz (busybox wget). Shell form so
# ${PORT} resolves. Railway ignores Docker HEALTHCHECK — point its own HTTP
# health check at /healthz; this covers local compose and any host that
# honors it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8081}/healthz" || exit 1

CMD ["node_modules/.bin/tsx", "apps/ws-gateway/src/index.ts"]

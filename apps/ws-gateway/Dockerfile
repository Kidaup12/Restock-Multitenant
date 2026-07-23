# ws-gateway — build from the monorepo root:
#   docker build -f apps/ws-gateway/Dockerfile -t wezesha-ws-gateway .
#
# Multi-stage: install the workspace subtree, bundle src/index.ts into one
# self-contained dist/index.cjs (see "build" script), run it on a bare
# node:22-alpine as a non-root user. The runner ships no node_modules — the
# bundle carries ws/ioredis/@wezesha/realtime; the only externals are ws's
# optional native addons (bufferutil, utf-8-validate), which ws falls back
# from cleanly when absent.

FROM node:22-alpine AS build
WORKDIR /repo

# Workspace graph first, for layer caching: lockfile + only the manifests this
# service needs. npm ci -w prunes install to the service and its workspace deps.
COPY package.json package-lock.json ./
COPY apps/ws-gateway/package.json apps/ws-gateway/
COPY packages/realtime/package.json packages/realtime/
RUN npm ci -w @wezesha/ws-gateway

COPY packages/realtime/ packages/realtime/
COPY apps/ws-gateway/ apps/ws-gateway/
RUN npm run -w @wezesha/ws-gateway build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/ws-gateway/dist/ ./
USER node

# Railway injects PORT; the app defaults to 8081 when unset.
EXPOSE 8081

# HTTP liveness via the gateway's /healthz (busybox wget). Shell form so
# ${PORT} resolves. Railway ignores Docker HEALTHCHECK — point its own HTTP
# health check at /healthz; this covers local compose and any host that
# honors it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8081}/healthz" || exit 1

CMD ["node", "--enable-source-maps", "index.cjs"]

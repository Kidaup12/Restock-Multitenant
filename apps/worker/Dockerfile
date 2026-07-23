# worker — build from the monorepo root:
#   docker build -f apps/worker/Dockerfile -t wezesha-worker .
#
# Multi-stage: install the workspace subtree, bundle src/index.ts into one
# self-contained dist/index.cjs (see "build" script), run it on a bare
# node:22-alpine as a non-root user. The runner ships no node_modules — the
# bundle carries bullmq/ioredis/@wezesha/realtime; the only external is
# msgpackr-extract (optional native addon of bullmq's msgpackr), which falls
# back to pure JS when absent.

FROM node:22-alpine AS build
WORKDIR /repo

# Workspace graph first, for layer caching: lockfile + only the manifests this
# service needs. npm ci -w prunes install to the service and its workspace deps.
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/realtime/package.json packages/realtime/
RUN npm ci -w @wezesha/worker

COPY packages/realtime/ packages/realtime/
COPY apps/worker/ apps/worker/
RUN npm run -w @wezesha/worker build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/worker/dist/ ./
USER node

# No HEALTHCHECK: the worker listens on nothing — process exit is the failure
# signal, and the platform restart policy is the supervisor.

CMD ["node", "--enable-source-maps", "index.cjs"]

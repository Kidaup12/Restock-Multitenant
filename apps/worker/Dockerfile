# worker — build from the monorepo root:
#   docker build -f apps/worker/Dockerfile -t wezesha-worker .
#
# Multi-stage: install the workspace subtree, generate the Prisma client, run
# via tsx (already a production dependency) on node:22-alpine as a non-root
# user. The runner keeps node_modules: the Prisma query engine is a native
# binary resolved relative to the generated client, which rules out the
# single-file esbuild bundle the pre-database worker shipped.

FROM node:22-alpine AS build
WORKDIR /repo

# Workspace graph first, for layer caching: lockfile + only the manifests this
# service needs. npm ci -w prunes install to the service and its workspace deps.
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/queue/package.json packages/queue/
COPY packages/realtime/package.json packages/realtime/
COPY packages/shopify/package.json packages/shopify/
# packages/db's postinstall is `prisma generate`, so the schema has to be in the
# image BEFORE the install — copying it with the rest of the source below is too
# late and fails the build.
COPY packages/db/prisma/ packages/db/prisma/
RUN npm ci -w @wezesha/worker

COPY packages/db/ packages/db/
COPY packages/observability/ packages/observability/
COPY packages/queue/ packages/queue/
COPY packages/realtime/ packages/realtime/
COPY packages/shopify/ packages/shopify/
COPY apps/worker/ apps/worker/

# Prisma CLI is a devDependency of @wezesha/db (not installed by the pruned
# ci); run it transiently to generate the client + linux-musl engine.
RUN npx --yes prisma@^6.1.0 generate --schema packages/db/prisma/schema.prisma

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build --chown=node:node /repo/ ./
USER node

# No HEALTHCHECK: the worker listens on nothing — process exit is the failure
# signal, and the platform restart policy is the supervisor.

CMD ["node_modules/.bin/tsx", "apps/worker/src/index.ts"]

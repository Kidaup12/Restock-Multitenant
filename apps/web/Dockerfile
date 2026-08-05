# web — build from the monorepo root:
#   docker build -f apps/web/Dockerfile -t wezesha-web .
#
# Local staging / self-hosted image. Production deploys go to Vercel (see
# deploy/RUNBOOK.md); this image exists so the full topology can run under
# docker compose. Multi-stage: install the web workspace, `next build` with
# standalone output (gated by NEXT_OUTPUT so host builds keep the default),
# run the traced server on a bare node:22-alpine as the non-root node user.

FROM node:22-alpine AS build
WORKDIR /repo

# Workspace graph first, for layer caching: lockfile + every manifest the web
# app resolves (it imports eight @wezesha/* packages). npm ci -w prunes the
# install to web and its workspace deps.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/forecast/package.json packages/forecast/
COPY packages/forecast-run/package.json packages/forecast-run/
COPY packages/observability/package.json packages/observability/
COPY packages/pos/package.json packages/pos/
COPY packages/queue/package.json packages/queue/
COPY packages/realtime/package.json packages/realtime/
COPY packages/shopify/package.json packages/shopify/
# packages/db's postinstall is `prisma generate`, so the schema has to be in the
# image BEFORE the install — copying it with the rest of the source below is too
# late and fails the build.
COPY packages/db/prisma/ packages/db/prisma/
RUN npm ci -w web

COPY packages/db/ packages/db/
COPY packages/forecast/ packages/forecast/
COPY packages/forecast-run/ packages/forecast-run/
COPY packages/observability/ packages/observability/
COPY packages/pos/ packages/pos/
COPY packages/queue/ packages/queue/
COPY packages/realtime/ packages/realtime/
COPY packages/shopify/ packages/shopify/
# `next build` type-checks the test files too, and tests/require-infra.ts imports
# the repo-root guard. Build stage only — the runner copies Next's standalone
# output, so none of this reaches the runtime image.
COPY scripts/ scripts/
COPY apps/web/ apps/web/

# @wezesha/db bundles its generated Prisma client (the build context excludes
# **/generated); generate it + the linux-musl engine before next build imports
# it. Prisma CLI is a devDependency of @wezesha/db not installed by the pruned
# ci — run it transiently, as the worker/ws-gateway images do.
RUN npx --yes prisma@^6.1.0 generate --schema packages/db/prisma/schema.prisma

# next build collects page data by evaluating route modules; @wezesha/db
# (client.ts) and Better Auth fail module init if these are unset. Build-only
# placeholders — pages are dynamic so nothing connects, and the separate runner
# FROM means they never reach the runtime image (real values come from the
# platform / compose env).
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    SERVICE_DATABASE_URL=postgresql://build:build@localhost:5432/build \
    DIRECT_URL=postgresql://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-only-secret \
    BETTER_AUTH_URL=http://localhost:3000
RUN npm run -w web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Standalone output mirrors the monorepo layout: server.js sits under apps/web,
# with the pruned node_modules at the standalone root. Static assets and public/
# are not traced — copy them in beside the server.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node

ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PORT:-3000}/" || exit 1

CMD ["node", "apps/web/server.js"]

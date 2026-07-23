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

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w web

COPY apps/web/ apps/web/
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
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

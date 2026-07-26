# @wezesha/ws-gateway

Standalone WebSocket fan-out service. Holds the sockets the serverless app and
workers can't: they publish events through `@wezesha/realtime` onto Redis
pub/sub, this process psubscribes `tenant:*` once and forwards each message
only to sockets bound to that channel's tenant.

A socket is bound at connect time: `authorizeSocket(token, requestedTenantId)`
(credential from `?token=`, `Authorization: Bearer`, or the Better Auth session
cookie; requested workspace from `?workspace=`) returns `{ tenantId }` or null →
close 4401.

Production runs `sessionAuthorizeSocket` (`src/auth.ts`): it validates the
caller's Better Auth session token against the `Session` table and picks the
tenant from the user's `Membership` rows. A requested `workspace` is honored only
when the user actually holds that membership — a forged or stale id closes the
socket rather than falling back to another tenant. That lookup is why the gateway
needs `SERVICE_DATABASE_URL`.

`WS_DEV_TOKEN` is a non-production convenience on top of that: when
`NODE_ENV` is anything but `production`, `{WS_DEV_TOKEN}:{tenantId}` tokens are
accepted alongside real sessions. Under `NODE_ENV=production` the dev authorizer
is never constructed, so the variable has no effect — including in the Docker
image, which sets `NODE_ENV=production`.

Defense in depth on fan-out: malformed envelopes are dropped, and a payload
whose `tenantId` disagrees with its channel is dropped too — a publisher bug
cannot cross tenants.

| Env | Default | |
|---|---|---|
| `PORT` | `8081` | listen port |
| `REDIS_URL` | `redis://localhost:6380` | pub/sub source |
| `DATABASE_URL` | — | Prisma client construction |
| `SERVICE_DATABASE_URL` | — | session + membership lookups |
| `WS_DEV_TOKEN` | unset | non-production only: also accept `{secret}:{tenantId}` tokens |

```
docker compose up -d redis
npm run -w @wezesha/ws-gateway dev
npm run -w @wezesha/ws-gateway test
```

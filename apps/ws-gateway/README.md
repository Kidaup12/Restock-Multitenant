# @wezesha/ws-gateway

Standalone WebSocket fan-out service. Holds the sockets the serverless app and
workers can't: they publish events through `@wezesha/realtime` onto Redis
pub/sub, this process psubscribes `tenant:*` once and forwards each message
only to sockets bound to that channel's tenant.

A socket is bound at connect time: `authorizeSocket(token)` (from `?token=` or
`Authorization: Bearer`) returns `{ tenantId }` or null → close 4401. The dev
authorizer accepts `{WS_DEV_TOKEN}:{tenantId}`; the real auth integration
replaces only that function (`src/auth.ts` documents the seam).

Defense in depth on fan-out: malformed envelopes are dropped, and a payload
whose `tenantId` disagrees with its channel is dropped too — a publisher bug
cannot cross tenants.

| Env | Default | |
|---|---|---|
| `PORT` | `8081` | listen port |
| `REDIS_URL` | `redis://localhost:6380` | pub/sub source |
| `WS_DEV_TOKEN` | unset | dev auth secret; unset rejects every connection |

```
docker compose up -d redis
npm run -w @wezesha/ws-gateway dev
npm run -w @wezesha/ws-gateway test
```

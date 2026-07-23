# @wezesha/realtime

Typed realtime event contract plus `publishEvent` — the one way anything
(Next.js routes, workers) pushes an event toward browsers. Publishers write to
Redis pub/sub on `tenant:{tenantId}`; the ws-gateway fans out to sockets.
Publishers never hold sockets themselves.

Two entries, one contract:

- `@wezesha/realtime` — server side: contract + the ioredis publisher.
- `@wezesha/realtime/client` — browser side: contract + `connect()`, a
  dependency-free reconnecting WebSocket client (backoff + jitter, `online`
  fast-retry, per-type subscriptions, connection-state events, malformed-frame
  counter). Browser code imports only this subpath; the bundle-safety test
  proves it reaches no server modules.

The gateway rejects a bad token by closing with 4401; the client treats that
as terminal (no retry loop against a dead token) — reconnect with a fresh
`connect()` once auth hands over a new one.

Adding an event: extend `RealtimeEventMap` in `src/events.ts` and add its
validator — the compiler forces the pair to stay in sync. Every event's data
must carry `tenantId`; the gateway drops any message whose payload tenant does
not match its channel.

```
npm run -w @wezesha/realtime test
```

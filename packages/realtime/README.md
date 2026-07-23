# @wezesha/realtime

Typed realtime event contract plus `publishEvent` — the one way anything
(Next.js routes, workers) pushes an event toward browsers. Publishers write to
Redis pub/sub on `tenant:{tenantId}`; the ws-gateway fans out to sockets.
Publishers never hold sockets themselves.

Adding an event: extend `RealtimeEventMap` in `src/events.ts` and add its
validator — the compiler forces the pair to stay in sync. Every event's data
must carry `tenantId`; the gateway drops any message whose payload tenant does
not match its channel.

```
npm run -w @wezesha/realtime test
```

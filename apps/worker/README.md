# @wezesha/worker

Background job runner. BullMQ on the shared Redis; jobs publish realtime
progress through `@wezesha/realtime` (the worker never holds sockets).

No-overlap contract: enqueue syncs only through `enqueueSyncOnce` — the
deterministic job id `sync:{tenantId}:{source}` makes BullMQ reject a duplicate
while one is queued or running, so a tenant's sync can never run twice
concurrently. Proven against real Redis in `tests/no-overlap.test.ts`.

The `sync` queue currently runs a demo processor (3 progress phases + done)
that exercises the full pipeline; real source syncs replace the processor body.

| Env | Default | |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6380` | queues + event publishing |

```
docker compose up -d redis
npm run -w @wezesha/worker dev
npm run -w @wezesha/worker test                    # redis-backed suites skip
REDIS_URL=redis://localhost:6380 npm run -w @wezesha/worker test   # full run
```

`tests/integration.test.ts` is the end-to-end proof: it spawns the real
ws-gateway, enqueues the demo job, and asserts one tenant's client receives
ordered progress while another tenant's client receives nothing.

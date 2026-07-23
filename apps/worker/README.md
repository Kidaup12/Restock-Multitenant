# @wezesha/worker

Background job runner. BullMQ on the shared Redis; jobs publish realtime
progress through `@wezesha/realtime` (the worker never holds sockets).

No-overlap contract: enqueue syncs only through `enqueueSyncOnce`
(`@wezesha/queue`) — the deterministic job id `sync:{tenantId}:{source}` makes
BullMQ reject a duplicate while one is queued or running, so a tenant's sync can
never run twice concurrently. Proven against real Redis in
`packages/queue/tests/no-overlap.test.ts`.

The `sync` queue dispatches on `data.source`:

- `shopify` — the real per-tenant sync (`src/shopify-sync.ts`): products →
  locations + inventory → orders-as-sales, per-resource `IngestCursor` advance,
  progress + done events, webhook registration. Rate limits surface as
  `ShopifyRateLimitedError`; the queue's custom backoff waits out the provider's
  Retry-After before the next attempt. Final failures persist a `Notification`
  ("please reconnect" on auth errors).
- anything else — the demo processor (3 progress phases + done) kept for
  pipeline smoke tests.

| Env | Default | |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6380` | queues + event publishing |
| `DATABASE_URL` | — | Prisma client construction (RLS role) |
| `SERVICE_DATABASE_URL` | — | the sync's writes (service role) |
| `TOKEN_ENCRYPTION_KEY` | — | decrypts stored Shopify tokens |
| `SHOPIFY_APP_URL` | unset (skips webhook registration) | public web origin |

```
docker compose up -d db redis
npm run -w @wezesha/worker dev
npm run -w @wezesha/worker test                    # redis/db-backed suites skip
REDIS_URL=redis://localhost:6380 npm run -w @wezesha/worker test   # full run
```

`tests/integration.test.ts` is the end-to-end proof: it spawns the real
ws-gateway, enqueues the demo job, and asserts one tenant's client receives
ordered progress while another tenant's client receives nothing.
`tests/shopify-sync.test.ts` runs the real sync processor against the local
database with the Shopify API faked at its injection seam.

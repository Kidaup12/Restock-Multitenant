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

Alongside the sync it runs six cron groups, each registered only when its
variable is set to `1` — so a worker started with none of them set does nothing
but serve the `sync` queue.

| Env | Default | |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6380` | queues + event publishing |
| `DATABASE_URL` | — | Prisma client construction (RLS role) |
| `SERVICE_DATABASE_URL` | — | the sync's writes (service role) |
| `TOKEN_ENCRYPTION_KEY` | — | decrypts stored Shopify tokens |
| `SHOPIFY_APP_URL` | unset (skips webhook registration) | public web origin |
| `POS_FEED_SECRET` | unset (no `Authorization` header) | bearer sent when pulling a tenant's POS feed URL |
| `FORECAST_CRON` | off | `1` = nightly forecast run + monthly backtest |
| `SNAPSHOT_CRON` | off | `1` = nightly on-hand snapshot (stock history) |
| `COST_CRONS` | off | `1` = nightly cost-moved check |
| `POS_CRONS` | off | `1` = daily POS sales-gap check |
| `OPS_CRONS` | off | `1` = daily plan-limit check |
| `EMAIL_CRONS` | off | `1` = weekly summary email |
| `BREVO_API_KEY` / `EMAIL_FROM` | unset | outbound mail; unset logs to the console |
| `SENTRY_DSN` | unset | error tracking; unset is a complete no-op |

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

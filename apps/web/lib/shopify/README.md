# Shopify integration — web glue

Server-side glue for the Shopify sync core. The protocol pieces (OAuth, HMAC,
GraphQL client, id/sales mappers, token crypto) live in `packages/shopify`; the
sync jobs live in `apps/worker/src/shopify-sync.ts`. This folder holds only
what the web routes need: env access, the queue handle, the membership gate,
and the non-session tenant resolver for webhooks.

Route map:

| Route | What it does |
|---|---|
| `GET /api/shopify/install?shop=` | state cookie + redirect to the store's authorize page |
| `GET /api/shopify/callback` | state + HMAC checks, token exchange, encrypted upsert, initial sync enqueue |
| `POST /api/shopify/sync` | sync-now; response carries the no-overlap verdict |
| `POST /api/shopify/disconnect` | stamps `uninstalledAt` (row + token kept for reconnect) |
| `POST /api/webhooks/shopify` | HMAC verify → `WebhookEvent` dedupe → enqueue / mark uninstalled |

UI: `/settings/connections`.

## Smoke path against a dev store

Needs a Shopify dev store + a Dev Dashboard app with the four read scopes
(`read_products, read_inventory, read_orders, read_locations`) and
`<SHOPIFY_APP_URL>/api/shopify/callback` in the app's redirect allow-list.
No credential ever goes in a file in this repo — env only.

1. Local stack: `docker compose up -d db redis`, migrate, then `npm run dev -w web`
   and `npm run dev -w @wezesha/worker`.
2. Env: fill `apps/web/.env` from `.env.example` (Shopify key/secret, a generated
   `TOKEN_ENCRYPTION_KEY`, `REDIS_URL`). Export the same `TOKEN_ENCRYPTION_KEY`,
   `SHOPIFY_APP_URL`, and DB/Redis URLs to the worker shell.
3. For webhooks + OAuth the app needs a public origin: run a tunnel to :3000 and
   set `SHOPIFY_APP_URL` to the tunnel origin (also update the app's redirect URL).
4. Sign up, then visit `/settings/connections` → Connect store → approve on the
   store. Expect: redirect back with "Store connected", worker log shows the sync,
   the card shows per-resource last-sync times on refresh.
5. `Sync now` twice quickly: the second response must report "already running" —
   that's the no-overlap guard, not a bug.
6. Edit a product in the store admin: a `products/update` webhook should enqueue a
   delta sync within seconds (watch the worker log; `WebhookEvent` gains a row).
7. Uninstall the app from the store: the connection flips to Disconnected and a
   `shopify_uninstalled` Notification row appears.

# Original-app changes ported on 5 November 2026

Source: `Kidaup12/wezesha-restock` main, `4eb1bc4..ee30e25` (plus Imports Watch,
deferred in the October port).

| Upstream | Here | Commit |
|---|---|---|
| #100 dead stock = no sales in N days **and** on the shelf N days | Shared rule in `@wezesha/forecast` (`isDeadStock`, `shelfDaysSince`); app, monthly history and owner report all use it | `97c608a` |
| #102 warehouse → shops only; drain the warehouse; skip 1–2 unit moves | `sizeTransfers` drain pass + small-move guard; Transfers offers warehouses only as source | `cacb138` |
| #96 report emails show the dashboard's run rate | `apps/worker/src/live-rates.ts` (same `runRateDaily` call as `lib/metrics/catalogue.ts`) | `0ec29e0` |
| #101 sync wording | Today › Advanced copy only | `0ec29e0` |
| #94/#95 Imports Watch | Generalised: products with a 14+ day lead time, per-shop switch (default off), opt-out per person | `b0bd177` |

Not ported: the middleware `getUser` timeout (no DB call in `proxy.ts`), the
rounding rebalance (`sizeTransfers` is already exact), the billing banner removal
and billing-email off-switch (no banner or billing emails here), and #101's
"manual run deletes pending orders" — here pending orders are buys a person
queued, so deleting them would lose work.

## New here (not upstream)

Recommendations (`4c7dc85`, `5dbc7e0`): nightly rules in
`packages/forecast/src/recommendations.ts`, worker job
`apps/worker/src/recommendations-cron.ts` (`RECOMMENDATION_CRONS=1`, 06:30), AI
wording with Claude Haiku (`ANTHROPIC_API_KEY`; optional, guarded so the model
can't introduce numbers), `/recommendations` tab and a linked bell notice.

## Deploy order

1. `prisma migrate deploy` — applies `20261105120000_stock_recommendations`
   (adds `Notification.href`, creates `StockRecommendation` with RLS). Web and
   worker both read `Notification.href`, so this must land first.
2. Deploy web and worker together.
3. Worker env: `RECOMMENDATION_CRONS=1`; optionally `ANTHROPIC_API_KEY`.
4. Imports Watch per shop: operator console → the shop → "Imports Watch email".

# Input/persistence audit — 5 October 2026

Scope: read-only production-source comparison against `../../_ref-wezesha-restock`.
No live data, API calls, migrations, or writes to customer systems. Characterization
tests mock database persistence and execute the actual POS ingest implementation;
Shopify cases execute the actual aggregator and are paired with source inspection
of its caller. Passing tests mean these observed behaviours were reproduced, not fixed.

Run from repository root:

```powershell
.\node_modules\.bin\vitest.cmd run --config scripts/audit-inputs/vitest.config.ts
```

## I1 — P1: partial POS batches destroy a complete daily total

`packages/pos/src/ingest.ts:113-122` builds totals from the current payload;
`:165` writes those totals; `:188-213` deletes the full product/day before replacing
it. The raw receipt store retains unrelated receipts (`:126-128`), but those retained
receipts are not read back to derive the day.

Reproduction: ingest receipts A=10 and B=2 for one day, then replay B alone.
Raw lines still total 12; SalesHistory becomes 2, an 83.33% undercount.
This directly corrupts demand, revenue, ABC, forecast and sales reports.

The original already has the missing safeguard:
`_ref-wezesha-restock/lib/pos/ingest.ts:106-114,141-202` rebuilds touched dates from
all stored raw receipts; `:209-234` also implements a trailing-window healing job.
Bring over the behaviour, with tenant isolation and atomic updates, rather than
copying just the pure batch aggregator.

## I2 — P1: corrections do not clear old POS identities/dates

Same writer, plus `packages/pos/src/aggregate.ts:161-166`: online receipts are
excluded before their external IDs enter the raw-store replacement set.

Reproductions through actual ingest with in-memory persistence:

- Move one 10-unit receipt from Oct 1 to Oct 2: raw units=10, derived units=20.
  Only the new date is rebuilt; the old derived date remains.
- Change a physical receipt to online: the old physical receipt and its 10-unit
  derived POS row remain. Once the online channel imports it, double counting is possible.

Repair must track both previous and new affected product/day keys before replacing
raw rows. Original touched-new-days rebuilding is useful, but also needs review
for old-day corrections; do not assume it solves this whole case.

## I3 — P1: Shopify delta query and full-day replacement are incompatible

`packages/shopify/src/resources.ts:191-210` requests orders by `updated_at`, while
`apps/worker/src/shopify-sync.ts:497-559` derives and replaces a full product/day
using only that returned subset. Flooring a cursor to midnight does not turn an
updated-at query into a complete history of the original sales date.

Deterministic aggregator case: historical orders of 10 and 2 units create 12;
later only the 2-unit order changes to 1. Updated subset produces 1, while the
correct full-day total is 11. The replacement semantics overwrite the other ten.
This is source-confirmed composition, not a live Shopify/DB reproduction.

The original shares the design issue (`lib/shopify/paginate.ts:125-142` and
`lib/shopify/sales-window.ts:58-95`); matching the original is not a correctness test.
Use an order-level ledger with corrections or refetch complete affected sale days.

## I4 — P1: full refunds/cancellations can leave stale Shopify sales

`packages/shopify/src/sales.ts:95,112-115` drops cancelled orders/fully returned
lines. `apps/worker/src/shopify-sync.ts:527` exits for an empty bucket set; otherwise
deletion is restricted to nonempty bucket days. Original stored sale keys are lost.

Executed aggregator case: a three-unit sale yields a bucket; a full refund yields
none. With the inspected early return, the previously stored three units are not
removed. Partial refunds in nonempty buckets work at the aggregator level, but
still have I3's subset problem. The original's refund handling is less complete;
retain the current support and fix the persistence contract.

## I5 — P2: revenue ignores discounts; large Shopify orders can be truncated

Source-confirmed: `packages/shopify/src/resources.ts:199-206` requests only the
first 50 line items and first 50 refund lines, with no nested pagination. A larger
order/refund can be incomplete even though outer order pagination succeeds.
It fetches `originalUnitPriceSet`; `packages/shopify/src/sales.ts:115-118` multiplies
that by net quantity. Discounted money actually collected is not an input here.
ABC/trailing revenue therefore uses gross original-price value for Shopify while
POS can use till subtotal. Confirm desired gross/net revenue semantics and align
both channels. Customer incidence and sizes require live data.

## I6 — P2: snapshot integrity and calendar uncertainty

`apps/worker/src/snapshot-cron.ts:75-77,117-139` uses UTC day keys and deletes a
whole day before chunked inserts, without a transaction. A failure after deletion
or an early chunk can leave missing coverage; a delayed retry keys itself by its
actual execution day rather than carrying the scheduled day in job data.
Sales ingestion uses tenant-local day markers (`packages/pos/src/time.ts:17-30`).
These calendars need an explicit shared contract for tenants outside UTC, especially
when execution crosses a local midnight. The original snapshot writer shares the
delete-then-create pattern and UTC day key (`lib/inventory/snapshot.ts:14-33`).
This is an inspected failure risk, not an injected live failure or proven customer incident.

## Existing safeguards to preserve

Exact SKU matching, retained unmatched receipts, within-payload external-ID dedup,
tenant-local sales dates, Shopify processedAt handling, variant-level matching,
refund netting, and available-vs-on_hand inventory semantics are improvements over
parts of the original. Test correction/replay semantics around them rather than
replacing them with older code.

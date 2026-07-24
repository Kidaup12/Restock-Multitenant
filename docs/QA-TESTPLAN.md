# QA test plan — exactly what to verify

For the reviewer. This is the "what to test and what 'correct' looks like" companion to the
high-level milestone message. Run against a local setup (`docs/QUICKSTART.md`) on seeded demo data.

**What this build is:** built + self-tested (automated suites green). **What it is not:** QA'd — that's
this pass. Log anything that doesn't match "expected" below. Check the **Known gaps** section first so
you don't file already-known items as bugs.

## Setup & report
1. `npm run setup` → `npm run dev` → sign in `owner@wezesha.test` / `Owner12345!` (owner).
2. Report format per issue: **area · steps · expected · actual · severity** (blocker / major / minor).
   Screens or a short clip help.

## Roles for testing — all three are seeded (same tenant)
| Role | Sign-in | Sees costs/margins? |
|---|---|---|
| **Owner** | `owner@wezesha.test` / `Owner12345!` | Yes — everything |
| **Admin** | `admin@wezesha.test` / `Admin12345!` | Yes — can also manage settings |
| **Member (staff)** | `staff@wezesha.test` / `Staff12345!` | **No — money-blind** |

Log in as the **member** to verify money-blind (section 4): no cost or profit figure should appear
anywhere. (Inviting *new* users needs email, which is console-only for now — see Known gaps — but
these three exist out of the box.)

---

## Test areas

### 1. Setup & onboarding
- `npm run setup` from a fresh clone brings up a working app in one command (Windows/macOS/Linux).
- **Expected:** completes without manual steps; app loads; demo data present (~30 products, sales,
  orders).

### 2. Auth & access
- Sign in / out; wrong password rejected; sign-in-with-code path.
- **Expected:** clean auth; landing on Today after login.

### 3. SECURITY — tenant isolation (critical)
- With two workspaces, confirm you only ever see the active shop's products/sales/costs/suppliers.
- **Expected:** no data from another shop appears anywhere; switching workspace fully swaps the data.

### 4. SECURITY — money-blind / staff (critical)
- As a **member**, visit Today, Stock, Costs, Plan, Orders, a PO and its print view, Suppliers, Sales,
  Reports.
- **Expected:** **no cost or profit/margin figure appears anywhere** — cost fields show a mask
  (`KES •••`). Selling prices and revenue are fine (staff may see those). The supplier PO *email* is
  the only place cost is intentionally present (it goes to the supplier, not shown to the member).

### 5. Today
- Money picture: 30-day revenue + trend, tracked products, stockouts, cash in dead stock; the reorder
  list; "Run forecast" button.
- **Expected:** tiles reconcile with Stock/Sales; running the forecast repopulates the reorder list.

### 6. Stock (catalogue)
- Product list with ABC class, cover/days-left, run-rate; the money band + cost-health chips
  (owner only); "not for sale" toggle.
- **Expected:** testers/warehouse stock not counted as sellable; ABC + cover match Today/Plan.

### 7. Costs
- Coverage %, source split (typed/QuickBooks/Shopify/missing), cost-moved (>20%) alerts; upload/paste
  costs.
- **Expected:** suspect costs (zero, or ≥ price) held off the buy list; a manual cost survives a sync.

### 8. Suppliers
- Supplier list + lead times (typed vs learned), scorecards, bulk-assign by brand.
- **Expected:** lead time drives order timing + safety stock; receiving doesn't silently overwrite a
  typed lead time.

### 9. Plan (buy list)
- Two modes: checklist (order today / this week / can wait) and budget allocator; per-line "why"
  (the arithmetic); funded vs deferred; CSV/PDF export.
- **Expected:** quantities have a visible reason; changing the budget rebuilds the list; export works.

### 10. Orders & receiving
- Draft a PO → (email to supplier) → receive; on-hand updates on receipt.
- **Expected:** received quantities update stock; costs redacted for members.

### 11. Sales / POS reconciliation
- Unmatched-SKU queue (match a till SKU to a product), "not a product" ignore, sales-gap list.
- **Expected:** unmatched till sales are surfaced (never silently dropped); matching back-fills history.

### 12. Forecast (engine)
- Run the forecast; check recommended quantities on Today/Plan.
- **Expected:** sensible quantities with the "why"; out-of-stock periods don't read as "not selling".
  (The confidence words / cold-start / accuracy screens are **not rendered yet** — see Known gaps.)

---

## Known gaps — do NOT log these as bugs (yet)
- **Forecast "trust" screens not rendered** — confidence words, cold-start queue, backtest accuracy,
  Insights proof, "tell the forecast" are built in the engine but have no UI yet. Insights is a
  placeholder.
- **Planner depth in progress** — cover-days sizing, scope filters, exclude-already-ordered warnings,
  MOQ rounding, supplier-grouped draft POs, sales-target mode, supply calendar are not in `/plan` yet.
- **Signals not built** — no way yet to declare a promo / shop closure; and **past promo spikes and
  closed-day gaps are not yet removed from the run-rate** (a known bug being fixed — expect some
  over/under-ordering around promos/closures). Stockout gaps *are* handled.
- **Live Shopify not connected** — the demo runs on seeded data, not the live store's 276 orders
  (that's the hosted/OAuth step).
- **Emails are console-only** — team invites / codes / alerts are logged, not delivered yet.
- **No end-to-end/UI tests** — so please click broadly.

## Lower-priority items already known (dev-side)
- ABC velocity uses the un-gap-corrected rate; the sales-gap list uses a slightly different
  "sells" filter than the cron. Neither is user-blocking.

Full architecture, data flow, branch model, and the feature/route map: `docs/ARCHITECTURE.md`.

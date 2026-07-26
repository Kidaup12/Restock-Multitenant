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

### 2b. Creating a workspace (new — no invite needed)
- Sign up as a brand-new email, with no invite waiting. From the empty Today screen (or the
  workspace switcher) create a workspace, then create a second one from the switcher.
- Try a name someone else has already used, and double-click the create button.
- **Expected:** you land in the new workspace as its owner with an empty catalogue; a name already
  in use still works and quietly gets its own address; a double-click leaves one workspace, not two;
  nothing from any other shop is visible inside it.

### 3. SECURITY — tenant isolation (critical)
- With two workspaces, confirm you only ever see the active shop's products/sales/costs/suppliers.
- **Expected:** no data from another shop appears anywhere; switching workspace fully swaps the data.

### 4. SECURITY — money-blind / staff (critical)
- As a **member**, visit Today, Stock, Costs, Plan (all three modes), Orders, a PO and its print
  view, Suppliers, Sales data.
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

### 9. Plan (buy list) — newest code, test it hardest
- Three modes off the Plan landing: **checklist** (order today / this week / can wait), **budget
  allocator** (funded vs deferred; a Growth-plan feature — Starter sees it locked), and the
  **supply calendar** (the next few months of order-by dates grouped by supplier, with the cash
  each month needs).
- Checklist depth to exercise: the decision header (can't-wait count, cash for the critical lines,
  sales at risk, products in view); the scope bar (ABC / category / supplier / lead-band, saveable
  and reloadable); per-line "why" (the arithmetic); the MOQ floor note (`N → M (MOQ)`); the
  "Held off the list" section (already on an order, unplannable, slow mover); the cover-days lens
  and the sales-push what-if; the owner quantity override; CSV / copy / Save-PDF export.
- **Expected:** every quantity has a visible reason; changing the budget, the cover lens or the
  sales push rebuilds the list; the header totals track the scope on screen; an export contains
  exactly the rows currently visible; a member sees the same rows with every cost figure masked.

### 10. Orders & receiving
- Draft a PO → (email to supplier) → receive; on-hand updates on receipt.
- **Expected:** received quantities update stock; costs redacted for members.

### 11. Sales / POS reconciliation
- Unmatched-SKU queue (match a till SKU to a product), "not a product" ignore, sales-gap list and
  its two dismissals ("shop was closed" vs a missing feed).
- **Expected:** unmatched till sales are surfaced (never silently dropped); matching back-fills
  history; a day dismissed as closed stops being reported as a gap and stops counting against the
  run rate on the next forecast.

### 12. Forecast (engine)
- Run the forecast; check recommended quantities on Today/Plan.
- **Expected:** sensible quantities with the "why"; out-of-stock periods don't read as "not selling".
  (The confidence words / cold-start / accuracy screens are **not rendered yet** — see Known gaps.)

---

## Known gaps — do NOT log these as bugs (yet)
- **Forecast "trust" screens not rendered** — confidence words, cold-start queue, backtest accuracy,
  Insights proof, "tell the forecast" are built in the engine but have no UI yet. Insights is a
  placeholder.
- **No way to declare a promotion** — a shop closure *can* be recorded (Sales → sales-gap list →
  "Shop was closed"), and once a promo window or a closure day exists the forecast leaves those days
  out of the run rate. But nothing in the UI creates a promo window yet, so a past promotion still
  inflates the rate until one does. Stockout gaps are handled.
- **The plan doesn't raise the PO itself** — ticking lines adds them to the Orders queue, and that
  queue is where they group by supplier and become a purchase order. There's no supplier-grouped
  draft straight off `/plan`.
- **Live Shopify not connected** — the demo runs on seeded data, not a live store's order history
  (that's the hosted/OAuth step).
- **Emails are console-only** — team invites / codes / alerts are logged to the server console
  rather than delivered, until a Brevo API key is set.
- **No end-to-end/UI tests** — so please click broadly.

## Lower-priority items already known (dev-side)
- ABC velocity uses the un-gap-corrected rate; the sales-gap list uses a slightly different
  "sells" filter than the cron. Neither is user-blocking.

Full architecture, data flow, branch model, and the feature/route map: `docs/ARCHITECTURE.md`.

# QA test plan — exactly what to verify

For the reviewer. This is the "what to test and what 'correct' looks like" companion to the
milestone summary.

**What this build is:** built and self-tested — the automated suites are green.
**What it is not:** QA'd. That's this pass. Nothing here has been signed off by an independent
tester, and two of the most important checks (sections 3 and 4) have never been run by a human at
all — they need a second person and a second workspace, which is exactly what you bring.

Read **Known gaps** at the bottom first, so you don't spend time filing things we already know.

---

## Pick where you test

There are two environments. **Do both** — they cover different things, and some bugs only appear in
one.

| | **A. Local build** | **B. Deployed app** |
|---|---|---|
| Where | Your machine, `npm run setup` | https://restock-multitenant-web.vercel.app |
| Data | Demo shop, seeded, ~30 products | A real Shopify store's live data |
| Best for | Everything functional; the three roles exist out of the box | Shopify connect + sync, email, anything "does it work for real" |
| Can't do | Live Shopify sync (needs a public address) | Sign in as a pre-made role — you make your own accounts |

### A. Local build

Prerequisites and the one command are in [QUICKSTART.md](QUICKSTART.md): clone, `npm run setup`,
`npm run dev`. It installs everything, starts the database, applies migrations and loads demo data.
It's idempotent — safe to re-run whenever you want a clean shop back.

Three sign-ins exist in the seeded shop:

| Role | Sign-in | Sees costs and profit? |
|---|---|---|
| **Owner** | `owner@wezesha.test` / `Owner12345!` | Yes — everything |
| **Admin** | `admin@wezesha.test` / `Admin12345!` | Yes, and can manage settings |
| **Member (shop staff)** | `staff@wezesha.test` / `Staff12345!` | **No — money-blind** |

Locally, emails (invites, sign-in codes, purchase orders) print to the terminal running the app
instead of being sent. The link you need is in that terminal window.

### B. Deployed app

Sign up with your own email and set your own password — there is no shared login and you should
never be given one. Two ways in, and **please do both**:

1. **Your own workspace.** Sign up, then create a workspace from the empty screen or the workspace
   switcher. You are its owner. This is the path a new customer takes.
2. **Invited into the existing shop.** Ask to be invited as a **Member** from Settings → Team. This
   is how you test money-blind (section 4) against real data. Invite emails really send here.

Connecting **your own** Shopify store is currently blocked — the app has no distribution method set,
so Shopify refuses the install for any store outside our Partner organisation (see Known gaps). Test
the Shopify side against the store already connected on the deployed app.
[SHOPIFY-DEV-STORE.md](SHOPIFY-DEV-STORE.md) covers the your-own-store route for when that is fixed.
You do not need, and should not be given, anyone's Shopify password.

### Reporting

Per issue: **area · steps · expected · actual · severity** (blocker / major / minor), and say which
environment. A screenshot or short clip helps a lot. If something is in Known gaps, skip it.

---

# Priority 1 — the two security tests

These are the product's core promises. Both are **currently unverified by any human**. If only two
things get tested this pass, make it these.

## 1. Tenant isolation — no shop ever sees another shop's data

The whole product rests on this. Two customers share one system and must be sealed from each other.

**Setup:** two workspaces. Either create two yourself, or use yours plus the existing shop. Put
recognisably different data in each — a product name you'd spot instantly, a supplier, a cost.

**Check, in both directions:**
- Every screen shows only the active shop: Today, Stock, Sales, Costs, Suppliers, Plan, Orders,
  Transfers, Settings (Team, Locations).
- Switching workspace swaps **all** of it. Nothing from the previous shop lingers — including after
  a page refresh, and in exports (CSV, PDF, the purchase-order print view).
- Search and filters never surface another shop's products or suppliers.
- If you can get hold of a record's id (from a URL or an export) from shop A, opening that URL while
  signed into shop B must **not** show it. This is the important one — try it.

**Expected:** no data from another shop appears anywhere, ever, by any route.
**Severity if it fails: blocker.** Report it immediately and privately, not in a group thread.

## 2. Money-blind — shop staff never see cost or profit

Staff can see what things sell for; they must never see what they cost or what the shop makes.

**Setup:** sign in as the **Member** role (locally `staff@wezesha.test`; on the deployed app, get
invited as a Member).

**Walk every one of these:** Today · Stock (and the row editor, and a CSV export) · Costs · Plan in
all three modes (checklist, budget, calendar) and its export · Orders · a purchase order and its
print view · Suppliers · Sales · Transfers · Insights.

**Expected:** no cost, buying price, margin or profit figure appears anywhere. Cost fields show a
mask (`•••`). Selling prices and revenue **are** allowed — staff may see those. The only place a
cost legitimately appears is the purchase-order email that goes to the supplier, which staff don't
see.

**Look past the obvious ones**: tooltips, aria-labels, table headers, chart hover text, sort orders
that leak ranking, CSV and PDF exports, and any error message. A masked figure that's still in the
downloaded file is a failure.
**Severity if it fails: blocker.**

---

# Test areas

### 3. Setup and onboarding
- `npm run setup` from a fresh clone reaches a working app in one command (Windows, macOS, Linux).
- **Expected:** no manual steps; app loads; demo data present.

### 4. Auth and access
- Sign in and out; wrong password rejected; the sign-in-by-code path.
- **Expected:** clean auth, landing on Today.

### 5. Creating a workspace
- Sign up as a brand-new email with no invite waiting. Create a workspace from the empty Today
  screen or the switcher, then create a second one from the switcher.
- Try a name someone else already used, and double-click the create button.
- **Expected:** you land in the new workspace as owner with an empty catalogue; a name already in
  use still works and quietly gets its own address; a double-click leaves one workspace, not two;
  nothing from any other shop is visible inside it.

### 6. Connecting Shopify (deployed app)
- Connect a store from Settings → Connections, watch the first sync, then use "Sync now".
- **Expected:** the connection shows as live; products, stock levels, locations and past sales
  arrive; a product with several variants (shades, sizes) becomes **one row per variant**, each with
  its own stock, price and SKU — not one row for the whole product.
- Archive or delete a product in Shopify, sync again: it should stop appearing on the buy list.

### 7. Today
- Revenue and trend for the last 30 days, tracked products, stockouts, cash tied up in dead stock,
  the reorder list, and the "Run forecast" button.
- **Expected:** tiles reconcile with Stock and Sales; running the forecast repopulates the reorder
  list. The dashboard deliberately shows **no** order quantities or order cost — that lives on the
  planner. That's intended, not a bug.

### 8. Stock (the catalogue)
- Product list with ABC class, cover/days-left, run rate; the money band and cost-health chips
  (owner only); the "not for sale" toggle; filters, sorting, the row editor, CSV export.
- **Expected:** tester and warehouse stock isn't counted as sellable; ABC and cover match Today and
  Plan; a count on a chip matches the number of rows you get when you filter by it.

### 9. Costs
- Coverage percentage, the source split, cost-moved alerts, and upload/paste of costs.
- **Expected:** suspect costs (zero, or higher than the selling price) are held off the buy list; a
  manually typed cost survives the next sync.

### 10. Suppliers
- Supplier list, lead times (typed vs learned), scorecards, bulk-assign by brand.
- **Expected:** lead time drives order timing and safety stock; receiving a delivery doesn't
  silently overwrite a lead time someone typed.

### 11. Plan (the buy list) — newest code, test it hardest
- Three modes: **checklist** (order today / this week / can wait), **budget allocator** (funded vs
  deferred), and the **supply calendar** (order-by dates by supplier, with the cash each month
  needs).
- Depth worth exercising: the decision header; the scope bar (ABC, category, supplier, lead band —
  saveable and reloadable); per-line "why" arithmetic; the minimum-order-quantity note; the "held
  off the list" section; the cover-days lens; the sales-push what-if; the owner quantity override;
  and CSV / copy / save-PDF export.
- **Expected:** every quantity has a visible reason; changing the budget, lens or sales push rebuilds
  the list; header totals track what's on screen; an export contains exactly the rows currently
  visible.

### 12. Orders and receiving
- Draft a purchase order, email it to a supplier, receive it.
- **Expected:** received quantities update stock; costs stay hidden from members.

### 13. Sales and till reconciliation
- The unmatched-SKU queue, "not a product" ignore, the sales-gap list and its two dismissals
  ("shop was closed" vs a missing feed).
- **Expected:** unmatched till sales are always surfaced, never silently dropped; matching back-fills
  history; a day dismissed as closed stops being reported as a gap and stops dragging the run rate
  down.

### 14. Forecast
- Run the forecast; check the recommended quantities on Today and Plan.
- **Expected:** sensible quantities with a visible "why"; a period when something was out of stock
  doesn't read as "nobody wanted it".
- **Important caveat:** on the live store, all the order history was created in one burst, so run
  rates are currently meaningless and forecast *numbers* can't be judged yet. Test the **behaviour**
  (does it explain itself, does it exclude the right products), not the quantities. A back-dated
  history generator is being built to fix this.

---

## Known gaps — please don't file these

Verified against the code on 28 July. Anything not on this list is fair game.

**No store but ours can install the app.** The Shopify app has no distribution method selected, so
any store outside our Partner organisation gets "This app can't be installed yet." That blocks the
your-own-store test, and it blocks real customers too — it needs a change in the Partner dashboard,
not in the code.

**Plan tier locks out a new workspace.** A newly created workspace has no plan, which counts as
*starter*, and there is **no upgrade path in the app**. So Insights, Transfers, the budget
allocator, multi-location features and supplier PO email are all locked in any workspace you create
yourself. The core loop (stock, costs, suppliers, forecast, buy list) is not locked. Test those
features in the existing seeded/demo shop instead, which is on a higher tier.

**The guided tour points at a locked screen.** The tour that auto-starts for a new workspace
includes an Insights step, which that same workspace can't open.

**The Today setup strip isn't clickable.** It shows "Level 0 of 3" and tells you what to turn on
next, but the prompt is text — there's no link to the screen it names.

**Everything is in KES.** Currency is hard-coded throughout, regardless of the shop. A non-Kenyan
store still sees shillings on every screen. Being fixed. (Two things that are *not* this bug and do
show other currencies correctly: the currency picker on a supplier, and the currency on a purchase
order.)

**No sync progress yet.** While a sync runs, the Connections screen just says "never" for each
resource until that stage finishes — on a big catalogue that's minutes of apparent silence. Being
fixed; if you're testing after that lands, please test it hard.

**QuickBooks doesn't exist.** It's named on the Settings hub, the Costs page header and a Costs card,
and "from QuickBooks" appears as a cost source on Stock. There is no integration behind any of it.
The Settings hub also promises a POS card on the Connections screen; there isn't one.

**POS/till connectors aren't started.** The ingest endpoint and the reconciliation screens exist,
but nothing connects to a real till system yet.

**Cost import mishandles odd numbers.** In an uploaded cost file, `-50` is imported as `50`, `(50)`
as `50`, and `1.234.50` as `1.234`. Only clean numbers are safe today.

**Per-product lead time can't be set.** A product can override its supplier's lead time in the data,
but no screen writes it. Supplier-level lead time works and is both typeable and learned from
deliveries.

**Forecast trust screens aren't built.** Confidence wording, the cold-start queue, backtest accuracy
and "tell the forecast" exist in the engine but have no screen.

**No way to declare a promotion.** A shop closure can be recorded (Sales → sales-gap list → "shop was
closed"), and closures and promo windows are correctly left out of the run rate once they exist —
but nothing in the app creates a promo window yet, so a past promotion still inflates the rate.
Stockout gaps are handled properly.

**The plan doesn't raise the purchase order itself.** Ticking lines adds them to the Orders queue,
where they group by supplier and become a PO. There's no supplier-grouped draft straight off Plan.

**No automated click-through tests.** There is no end-to-end UI test suite, which is precisely why
manual clicking matters here. Click broadly and oddly.

## Two traps that will waste your time if nobody warns you

- **After a new version deploys, open a fresh tab.** A tab left open from before the deploy will
  throw a 404 on actions that look completely broken but aren't.
- **Locally, emails go to the terminal**, not an inbox. Invite and sign-in links are printed there.

---

Full architecture, data flow and the feature/route map: [ARCHITECTURE.md](ARCHITECTURE.md).

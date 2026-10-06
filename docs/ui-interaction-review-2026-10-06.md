# UI interaction review — 6 October 2026

This records the current working-tree review against `_ref-wezesha-restock`. It does **not** establish complete original-feature parity, publication, or deployment. Authenticated live checks exercised the previously deployed version; the local fixes below require deployment and a fresh browser pass before they can be described as verified live.

## What was exercised

- Authenticated live routes opened without a route crash during the reviewed flows. Dashboard navigation covered four tiles and five tabs. Planner checks covered filtering, selection, explanation/Why disclosure, and opening the quantity editor. Opening an editor does not prove saving an order works.
- Live Reports review covered the Overview/Performance layouts and exposed oversized nested empty states. These were compacted locally while retaining the original messages, measurement requirements and populated views.
- Native clipboard copy succeeded in the live browser. CSV download completion remains unverified: the automation reported **Download was canceled**, including with an absolute destination.
- The live Member budget flow opened the form but calculation returned **Budget planning needs cost access.** This was a permission dead end, not a route crash. Local entry and direct-URL handling now require cost access and explain the restriction before the form; recommended purchasing remains available. Server authorization was not weakened.
- No real orders were submitted, stock was changed, or transfers were applied in these checks.

## Local changes reviewed

Reports keeps Overview, Performance and History. The original dashboard groups restock, stockout, incoming and dead stock into tabs; this application's corresponding functions span Today, Plan and Inventory. The review preserved original report measures and exports instead of deleting them to reduce density.

- Date controls stack at narrow widths; their input values remount when the selected dates change. KPI cards have more room on small screens. Weekly and History tables have bounded horizontal scrolling, cell spacing and wrapping for long product names. The period column is sticky only at `sm` and wider.
- Newly added observation coverage counts sit in expandable details. Missing evidence still remains distinguishable from a measured zero. Dead stock, excess stock and incoming cards explicitly describe current inventory independently of historical report dates.
- History search and product selection now preserve the selected range, ABC class and custom dates. Previously those links discarded the financial-report lens, so returning from History reset the report. History's own one-year event window remains independent.
- Chart proportion fixes address stockout and monthly-sales bars; the monthly dead-stock cards now use a responsive grid. These are presentation corrections, not new historical observations or changed forecast results.
- Planner controls retain the recommended list for members without cost access. Additional local filter-state fixes keep urgency in the URL, reset stale selected/allocated state when the dataset changes, and surface saved-scope errors.
- Transfer detail and editable proposal quantities are local work; they have not been established as deployed behavior.

## Automated evidence

- Parent's targeted run: **72 passed, 26 skipped across nine files**. Skipped cases are not passes and do not establish live integration behavior.
- Reports-focused run: **43 tests passed across six files**, including tab parsing/link construction, date windows, custom-range data bounds, panel wiring, CSV serialization and the new History navigation render regression.
- Planner mode suite: **8 render tests passed**, including both chooser/direct-budget URL permission cases and continued recommended-list access without cost permission.
- Changed Reports and planner files passed scoped ESLint during their respective edits. These results are not a claim of a fresh full production build after every subsequent team change.

## Export investigation and remaining checks

`out/export-audit/blob.html` reproduces the CSV callback shape with immediate Blob URL revocation and a separate ten-second delayed-revocation control. Both canceled in an isolated browser session. A new session with an explicit download directory also canceled. A normal click completed as an interaction but did not establish a saved artifact. This does **not** demonstrate an immediate-revocation race, so no speculative cleanup change was made.

Still required: save and inspect actual CSV artifacts, confirm browser print/Save PDF output and current-shop PDF content, and repeat authenticated clicks against the newly deployed build. Clipboard success does not imply the download/print paths work.

Remaining original differences include dashboard report pins and History edit/deleted-order events. Daily imports-watch remains explicitly deferred. The original Python model runtime is also distinct from the target engine; this UI review makes no model-parity claim. See [the report parity record](upstream-report-parity-2026-10-05.md) for calculation coverage and provenance limits.

## Transfers: local scope and remaining original differences

Local work adds a saved-plan detail route, destination-grouped review/export, save-to-detail navigation, source/destination stock columns, 30/60/90-day branch sales windows and editable draft quantities. Quantity updates retain tenant, permission and feature gates, transaction locking, whole-number bounds and a live source-availability cap across sibling allocations. Mocked/pure transfer suites and scoped lint passed; database-dependent cases were skipped. A demo transfer seed is idempotent and opt-in, but was **not run**. None of this establishes an authenticated transfer write or deployment.

Still absent from the original workflow: zero-rate seed-stock toggle; accepting individual/all recommendations grouped across source warehouses; an all-SKU warehouse/branch justification overview; rate-versus-quantity sorting; reopening final/exported plans; Shopify-specific inventory CSV and live apply. The current integration remains read-only for inventory, so live apply was deliberately not ported. These omissions prevent claiming complete transfer parity.
## Later verification in this session

- Authenticated `GET /api/reports/pdf` returned **200**, `application/pdf`, **4,941 bytes**, with a `%PDF-` signature. This confirms PDF generation; saved-file contents, visual layout and printing were not verified by that response check.
- A live Transfers DOM click on the actual **30d** link changed the URL to the selected `from=...&cover=30` state without an error. This verifies that cover navigation interaction, not a transfer write or all transfer controls. Source selection was still being checked when this note was added.
- The final production build passed and generated **68 static routes**, with elevated network access for font retrieval. The separate final web TypeScript check also passed (exit 0).
- Live History search and a visible product-result click opened the selected product's three recorded sales events without a route error.
- Live Transfers source selection switched to Kilimani and rendered 44 proposal rows, with the correct selected source, no page error and no page-level horizontal overflow. Source and cover tests did not save plans or move inventory.


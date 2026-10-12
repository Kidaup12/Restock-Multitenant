// Read-only audit: execute production pure functions without importing DB clients.
// Run from repository root: node scripts/audit-surfaces/evidence.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
const root = process.cwd();
function pure(file, dependencies = {}) {
  const text = fs.readFileSync(path.resolve(root, file), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const source = ast.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(ast)).join('\n');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {}, Date, Map, Set, console, ...dependencies };
  vm.runInNewContext(js, context, { filename: file });
  return context.exports;
}
const today = pure('apps/web/lib/data/today.ts', { isDeadStock: pure('apps/web/lib/inventory/dead-stock.ts').isDeadStock });
const original = pure('../_ref-wezesha-restock/lib/inventory/dead-stock.ts');
const owner = pure('apps/worker/src/owner-report.ts');
const transfer = pure('packages/forecast/src/transfers.ts');
const stock = pure('packages/db/src/inventory.ts');
const inbound = pure('packages/db/src/inbound.ts');
const asOf = new Date('2026-10-05T00:00:00Z');
const cutoff = +asOf - 90 * 86400000;
const originalNew = original.isDeadStock({ currentStock: 10, hasEverSold: false, soldInWindow: false, firstSeenAt: new Date('2026-10-04Z'), asOf });
const mtNew = today.pileFor({ onHandUnits: 10, lastSaleAt: null }, cutoff);
assert.equal(originalNew, false); assert.equal(mtNew, 'healthy');
console.log(JSON.stringify({ case: 'Never-sold one-day-old SKU, no snapshot coverage', originalDead: originalNew, multitenantPile: mtNew }));
const base = { periods: ['2026-W36'], granularity: 'week', products: new Map([['p', { abc: 'A', costKes: 50, priceKes: 100 }]]), deadStockWindowDays: 90 };
const week = owner.stockHealthByPeriod({ ...base, snaps: [{ period: '2026-W36', pid: 'p', minOh: 0, endOh: 0, daysOut: 7 }], sales: [{ period: '2026-W35', pid: 'p', qty: 14 }] })[0];
assert.equal(week.stockoutPct, 0); assert.equal(week.missedRevenueKes, 0);
console.log(JSON.stringify({ case: 'A-class bestseller out all 7 days, zero current-week sales', emailStockoutPercent: week.stockoutPct, emailMissedRevenue: week.missedRevenueKes, observedEmptyShelfPercent: 100 }));
const month = owner.stockHealthByPeriod({ ...base, periods: ['2026-09'], granularity: 'month', snaps: [{ period: '2026-09', pid: 'p', minOh: 10, endOh: 10, daysOut: 0 }], sales: [{ period: '2026-08', pid: 'p', qty: 14 }] })[0];
assert.equal(month.deadStockCount, 1);
const current = today.pileFor({ onHandUnits: 10, lastSaleAt: new Date('2026-08-31Z'), inStockDays: 30 }, cutoff);
assert.equal(current, 'healthy');
console.log(JSON.stringify({ case: 'Last sold Aug 31, no September sales, 90-day dead-stock window', emailSeptemberDead: month.deadStockCount, currentOctober5Pile: current }));
const level = { onHand: 10, available: 2 };
const destinations = [{ locationId: 'shop', onHand: 0, runRate: 1 }];
const emailTransfer = transfer.sizeTransfers(level.onHand, destinations, 14)[0].qty;
const uiTransfer = transfer.sizeTransfers(stock.sellableUnits(level), destinations, 14)[0].qty;
assert.equal(emailTransfer, 10); assert.equal(uiTransfer, 2);
console.log(JSON.stringify({ case: 'Warehouse physically holds 10, eight committed', emailTransfer, uiTransfer }));
assert.equal(inbound.effectiveOnOrder(0, 40), 40);
console.log(JSON.stringify({ case: 'Shopify inbound zero, sent PO 40 units outstanding', emailInbound: 0, stockAndPlanInbound: inbound.effectiveOnOrder(0, 40) }));
console.log('Five audit fixtures checked: new-product eligibility now matches original; other fixtures document remaining differences. No DB/network calls.');

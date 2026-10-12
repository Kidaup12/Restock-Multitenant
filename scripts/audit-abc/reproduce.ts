import assert from 'node:assert/strict';
import { assignAbc, trailingRevenue, saleSpanDays } from '../../packages/forecast/src/abc';
import { assignAbc as originalAssignAbc } from '../../../_ref-wezesha-restock/lib/forecast/abc';
import { weightedDailyRateAdjusted } from '../../packages/forecast/src/baseline';
import { walkForwardBacktest, methodDailyRate } from '../../packages/forecast/src/backtest';
import { demandRateFor } from '../../packages/forecast/src/layered';

const day = 86400000;
const now = new Date('2026-10-05T00:00:00Z');
const ago = (n: number) => new Date(+now - n * day);
const full = Array.from({ length: 90 }, (_, i) => ({date: ago(i + 1), quantity: 1, revenueKes: 100}));
const classify = (history: typeof full | {date: Date; quantity: number}[]) => assignAbc([{id:'sku', revenue:trailingRevenue(history, now), runRate:weightedDailyRateAdjusted(history, now), saleSpanDays:saleSpanDays(history, now)}]);
const liveClass = classify(full);
const backtestClass = classify(full.map(({date, quantity}) => ({date, quantity})));
assert.equal(liveClass.sku, 'A');
assert.equal(backtestClass.sku, 'C');
console.log('missing_revenue', JSON.stringify({liveClass, backtestClass, liveRevenue:trailingRevenue(full,now)}));

const cutoff = ago(30);
const stopped = Array.from({length:90}, (_,i)=>({date:new Date(+cutoff - (i+1)*day), quantity:1}));
const sparse = walkForwardBacktest([{productId:'stopped',abcClass:'A',history:stopped}], [cutoff], 30);
const padded = walkForwardBacktest([{productId:'stopped',abcClass:'A',history:[...stopped,{date:ago(1),quantity:0}]}], [cutoff], 30);
assert.equal(sparse.byClass.length,0);
assert.equal(padded.byClass.find(x=>x.abcClass==='A'&&x.method==='run_rate')?.happenedUnits,0);
console.log('silent_holdout',JSON.stringify({sparseScoreRows:sparse.byClass.length,paddedScore:padded.byClass.find(x=>x.abcClass==='A'&&x.method==='run_rate')}));

const twoSales=[{date:ago(80),quantity:40,revenueKes:4000},{date:ago(1),quantity:40,revenueKes:4000}];
const span=saleSpanDays(twoSales,now);
const burstClass=classify(twoSales);
assert.equal(burstClass.sku,'A');
console.log('stability_span',JSON.stringify({positiveSaleDays:2,span,rate:weightedDailyRateAdjusted(twoSales,now),burstClass}));

const dominant=[{id:'dominant',revenue:95,runRate:1,saleSpanDays:30},{id:'tail',revenue:5,runRate:1,saleSpanDays:30}];
console.log('pareto_boundary',JSON.stringify({original:originalAssignAbc(dominant),current:assignAbc(dominant)}));
assert.equal(originalAssignAbc(dominant).dominant,'C');
assert.equal(assignAbc(dominant).dominant,'A');

const maskedHistory=Array.from({length:90},(_,i)=>({date:ago(i+1),quantity:i<20?0:2})).filter(x=>x.quantity>0);
const stockoutDates=Array.from({length:20},(_,i)=>ago(i+1));
const liveRate=demandRateFor('run_rate',maskedHistory,now,{stockoutDates,snapshotsSince:ago(90)});
const testedRate=methodDailyRate('run_rate',maskedHistory,now);
assert.notEqual(liveRate,testedRate);
console.log('backtest_mask_mismatch',JSON.stringify({liveRate,testedRate,stockoutDays:20}));

const newborn=[{date:ago(1),quantity:5}];
const newbornScores=walkForwardBacktest([{productId:'newborn',abcClass:'C',history:newborn}],[cutoff],30);
assert.equal(newbornScores.byClass.find(x=>x.abcClass==='C'&&x.method==='run_rate')?.saidUnits,0);
console.log('no_training_history',JSON.stringify(newbornScores.byClass.find(x=>x.abcClass==='C'&&x.method==='run_rate')));
console.log('All six audit reproductions passed.');

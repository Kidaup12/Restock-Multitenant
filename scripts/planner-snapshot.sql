-- Planner snapshot: everything getBuyList reads for ONE workspace, as one JSON
-- value. Feed the result to apps/web/tests/planner-live-audit.test.ts:
--
--   PLANNER_SNAPSHOT=/path/to/snapshot.json npm run -w web test -- planner-live-audit
--
-- Read-only. Set the workspace name on the first line of the CTE.
-- The output holds costs and sales: keep the file out of git.
with t as (
  -- Several workspaces can share a name; take the one with the newest forecast.
  select tn.id, tn.name, tn.currency from "Tenant" tn
  where tn.name ilike '%treasured scents%'
  order by (select max(p."runDate") from "Prediction" p where p."tenantId" = tn.id) desc nulls last
  limit 1
),
latest as (
  select max(p."runDate") as run_date from "Prediction" p join t on t.id = p."tenantId"
),
preds as (
  select p.*, pr.sku, pr.title, pr.vendor, pr."priceKes", pr."costKes", pr."currentStock",
         pr."onOrder", pr."leadTimeDays", pr."abcCategory", pr."customCategory",
         s.name as "supplierName", s."leadTimeAvgDays", s."leadTimeStdDays", s.moq
  from "Prediction" p
  join t on t.id = p."tenantId"
  join latest on p."runDate" = latest.run_date
  join "Product" pr on pr.id = p."productId"
  left join "Supplier" s on s.id = pr."supplierId"
)
select json_build_object(
  'tenant', (select json_build_object('id', id, 'name', name, 'currency', currency) from t),
  'runDate', (select run_date from latest),
  'predictions', (select coalesce(json_agg(json_build_object(
      'id', id, 'productId', "productId", 'forecastRunId', "forecastRunId", 'runDate', "runDate",
      'daysUntilStockout', "daysUntilStockout", 'urgency', urgency, 'recommendedQty', "recommendedQty",
      'finalForecast30d', "finalForecast30d", 'layer1Forecast30d', "layer1Forecast30d",
      'safetyStock', "safetyStock", 'reasoning', reasoning, 'regime', regime,
      'confidenceWord', "confidenceWord", 'coldStart', "coldStart",
      'borrowedFromProductId', "borrowedFromProductId", 'explainParts', "explainParts",
      'product', json_build_object(
        'sku', sku, 'title', title, 'vendor', vendor, 'priceKes', "priceKes", 'costKes', "costKes",
        'currentStock', "currentStock", 'onOrder', "onOrder", 'leadTimeDays', "leadTimeDays",
        'abcCategory', "abcCategory", 'customCategory', "customCategory",
        'supplier', case when "supplierName" is null then null else json_build_object(
          'name', "supplierName", 'leadTimeAvgDays', "leadTimeAvgDays",
          'leadTimeStdDays', "leadTimeStdDays", 'moq', moq) end
      ))), '[]'::json) from preds),
  'overrides', (select coalesce(json_agg(json_build_object('productId', o."productId", 'qty', o.qty)), '[]'::json)
      from "ProductPlanOverride" o join t on t.id = o."tenantId"),
  'revenue30d', (select coalesce(json_agg(json_build_object('productId', "productId", 'revenueKes', rev)), '[]'::json)
      from (select sh."productId", sum(sh."revenueKes") as rev from "SalesHistory" sh join t on t.id = sh."tenantId"
            where sh.date >= now() - interval '30 days' group by sh."productId") r),
  'onTheWayProductIds', (select coalesce(json_agg(distinct o."productId"), '[]'::json)
      from "Order" o join t on t.id = o."tenantId"
      left join "PurchaseOrder" po on po.id = o."purchaseOrderId"
      where o."receivedAt" is null and o."productId" is not null
        and (o.status = 'pending'
             or (o.status = 'ordered' and po.status in ('sent','partially_received') and po."deletedAt" is null))),
  'poLines', (select coalesce(json_agg(json_build_object('productId', l."productId", 'quantity', l.quantity,
        'receivedQty', l."receivedQty", 'status', po.status)), '[]'::json)
      from "PurchaseOrderLine" l join "PurchaseOrder" po on po.id = l."purchaseOrderId" join t on t.id = l."tenantId"
      where po."deletedAt" is null and po.status in ('draft','sent','partially_received'))
) as snapshot;

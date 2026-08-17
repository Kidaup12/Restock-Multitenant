"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { formatMoney, formatNumber } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";
import type { PosMatchProduct, UnmatchedPosSku } from "@/lib/data/pos-queues";
import { ignorePosSkuAction, matchPosSkuAction } from "./actions";

/**
 * One unmatched till-SKU row: match it to a catalogue product (defaulting to the
 * suggested match) or mark it "not a product". Admin-only actions — a non-admin
 * sees the row but the controls are replaced with a hint.
 */
export function UnmatchedRow({
  row,
  products,
  canFix,
}: {
  row: UnmatchedPosSku;
  products: PosMatchProduct[];
  canFix: boolean;
}) {
  const currency = useCurrency();
  const [productId, setProductId] = useState(row.suggestion?.productId ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [matching, startMatch] = useTransition();
  const [ignoring, startIgnore] = useTransition();

  const match = () => {
    setError(null);
    setMessage(null);
    startMatch(async () => {
      const result = await matchPosSkuAction({ sku: row.sku, productId });
      if (result.ok) setMessage(result.message ?? "Matched.");
      else setError(result.error);
    });
  };

  const ignore = () => {
    if (!window.confirm(`Ignore "${row.sku}" as "not a product"? It won't queue again.`)) return;
    setError(null);
    setMessage(null);
    startIgnore(async () => {
      const result = await ignorePosSkuAction({ sku: row.sku });
      if (result.ok) setMessage(result.message ?? "Ignored.");
      else setError(result.error);
    });
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-edge px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs text-ink">{row.sku}</p>
        {row.productName && <p className="truncate text-xs text-ink-muted">{row.productName}</p>}
      </div>
      <div className="shrink-0 text-right text-xs text-ink-secondary tabular-nums">
        <p>{formatNumber(row.units)} units</p>
        <p>{formatMoney(row.revenueKes, currency)}</p>
      </div>

      {canFix ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Select
              size="sm"
              className="max-w-52"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
            >
              <option value="">Pick a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.sku})
                </option>
              ))}
            </Select>
            {row.suggestion && productId === row.suggestion.productId && (
              <Badge tone="accent">Suggested</Badge>
            )}
          </div>
          <Button size="sm" onClick={match} loading={matching} disabled={!productId}>
            Match
          </Button>
          <Button size="sm" variant="ghost" onClick={ignore} loading={ignoring}>
            Not a product
          </Button>
        </div>
      ) : (
        <Badge tone="neutral">Ask an admin to match</Badge>
      )}

      {message && (
        <p className="w-full text-xs text-positive" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="w-full text-xs text-negative" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

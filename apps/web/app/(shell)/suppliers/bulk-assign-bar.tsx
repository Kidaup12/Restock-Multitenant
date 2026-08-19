"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { SupplierOption, UnassignedBrand } from "@/lib/data/suppliers";
import { bulkAssignByBrandAction, type SupplierActionResult } from "./actions";


/**
 * "Assign by brand" — the missing piece. Unassigned products grouped by Shopify
 * vendor, each with a suggested supplier, assigned to a whole brand in one
 * click. Hidden entirely when every product already has a supplier.
 */
export function BulkAssignBar({
  brands,
  supplierOptions,
  canManage,
  onResult,
}: {
  brands: UnassignedBrand[];
  supplierOptions: SupplierOption[];
  canManage: boolean;
  onResult: (result: SupplierActionResult) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>(
    () => Object.fromEntries(brands.map((b) => [b.vendor, b.suggestedSupplierId ?? ""])),
  );
  const [pending, startTransition] = useTransition();
  const [busyVendor, setBusyVendor] = useState<string | null>(null);

  if (brands.length === 0) return null;

  const totalProducts = brands.reduce((s, b) => s + b.productCount, 0);

  function assign(vendor: string) {
    const supplierId = picked[vendor];
    if (!supplierId) {
      onResult({ ok: false, error: "Pick a supplier for this brand first." });
      return;
    }
    setBusyVendor(vendor);
    startTransition(async () => {
      const result = await bulkAssignByBrandAction({ vendor, supplierId });
      onResult(result);
      setBusyVendor(null);
    });
  }

  return (
    <Card>
      <CardHeader
        title="Products without a supplier"
        subtitle={`${totalProducts} product${totalProducts === 1 ? "" : "s"} across ${brands.length} ${brands.length === 1 ? "brand" : "brands"} — assign a whole brand at once`}
      />
      <CardContent className="space-y-2 pt-4">
        {!canManage && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-secondary">
            Ask someone with settings access to assign these.
          </p>
        )}
        {brands.map((brand) => (
          <div
            key={brand.vendor}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-edge bg-surface-2/40 px-3 py-2"
          >
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium text-ink">{brand.vendor}</span>
              <Badge tone="warning">
                {brand.productCount} {brand.productCount === 1 ? "product" : "products"}
              </Badge>
              {brand.suggestedSupplierName && (
                <span className="text-xs text-ink-muted">
                  suggested: {brand.suggestedSupplierName}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor={`assign-${brand.vendor}`}>
                Supplier for {brand.vendor}
              </label>
              <Select
                size="sm"
                id={`assign-${brand.vendor}`}
                disabled={!canManage || pending}
                value={picked[brand.vendor] ?? ""}
                onChange={(e) =>
                  setPicked((prev) => ({ ...prev, [brand.vendor]: e.target.value }))
                }
              >
                <option value="">Pick supplier…</option>
                {supplierOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                disabled={!canManage || !picked[brand.vendor]}
                loading={pending && busyVendor === brand.vendor}
                onClick={() => assign(brand.vendor)}
              >
                Assign
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

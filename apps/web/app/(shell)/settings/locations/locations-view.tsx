"use client";

import { useState, useTransition } from "react";
import {
  LOCATION_ROLE_DESCRIPTIONS,
  type LocationType,
  roleOfType,
  typeOfRole,
} from "@wezesha/db/roles";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TillMappingRow } from "@/lib/data/pos-queues";
import {
  mapTillToLocation,
  setLocationRole,
  unmapTill,
  type LocationActionResult,
} from "./actions";

export type LocationRow = {
  id: string;
  name: string;
  isPrimary: boolean;
  locationType: string | null;
  role: "sells" | "holds" | "enroute" | "ignore";
  assumed: boolean;
  guessedRole: "sells" | "holds" | "enroute" | "ignore";
  unitsOnHand: number;
  stockValueKes: number | null;
};

// Role-oriented option labels (the owner thinks in roles; we store the enum).
const ROLE_OPTIONS: { type: LocationType; label: string }[] = [
  { type: "branch", label: "Sells — a shop" },
  { type: "warehouse", label: "Holds — a warehouse" },
  { type: "enroute", label: "En route — incoming" },
  { type: "virtual", label: "Ignore — doesn't count" },
];

const selectClass = cn(
  "h-8 rounded-md border border-edge bg-surface px-2 text-sm text-ink transition-colors",
  "outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
  "disabled:pointer-events-none disabled:opacity-60",
);

/**
 * Till → branch mapping. A till whose sales aren't pointed at a branch counts
 * in the shop totals but in no branch's run rate, so the Sales screen nags
 * about it and sends the owner here.
 */
export function TillsView({
  tills,
  locations,
  canManage,
}: {
  tills: TillMappingRow[];
  locations: { id: string; name: string }[];
  canManage: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const unmappedCount = tills.filter((t) => t.locationId == null).length;

  function run(action: () => Promise<LocationActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader
        title="Tills"
        subtitle="Point each till at the branch it sits in, so its sales count towards that branch's run rate."
        action={unmappedCount > 0 ? <Badge tone="warning">{unmappedCount} unmapped</Badge> : undefined}
      />
      <CardContent className="p-0 pt-4">
        {error && (
          <p role="alert" className="mx-5 mb-3 rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
            {error}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableHead>Till</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead numeric>Sales</TableHead>
          </TableHeader>
          <TableBody>
            {tills.map((till) => (
              <TableRow key={till.warehouse}>
                <TableCell className="font-medium text-ink">
                  <span className="inline-flex items-center gap-2">
                    {till.warehouse}
                    {till.locationId == null && <Badge tone="warning">Not mapped</Badge>}
                  </span>
                </TableCell>
                <TableCell>
                  <select
                    aria-label={`Branch for ${till.warehouse}`}
                    value={till.locationId ?? ""}
                    disabled={!canManage || pending}
                    onChange={(e) =>
                      run(() =>
                        e.target.value === ""
                          ? unmapTill({ warehouseName: till.warehouse })
                          : mapTillToLocation({
                              warehouseName: till.warehouse,
                              locationId: e.target.value,
                            }),
                      )
                    }
                    className={selectClass}
                  >
                    <option value="">Not mapped — sales count for no branch</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </TableCell>
                <TableCell numeric>{formatNumber(till.salesCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function LocationsView({
  rows,
  canManage,
  canViewCosts,
  assumedCount,
  ignoreStockValueKes,
}: {
  rows: LocationRow[];
  canManage: boolean;
  canViewCosts: boolean;
  assumedCount: number;
  ignoreStockValueKes: number | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<LocationActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="space-y-6">
      {assumedCount > 0 && (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {assumedCount === 1
            ? "1 location has a guessed role."
            : `${assumedCount} locations have guessed roles.`}{" "}
          {canManage
            ? "Confirm each one — it's a one-time step."
            : "Ask someone with settings access to confirm them."}
        </p>
      )}

      {ignoreStockValueKes != null && ignoreStockValueKes > 0 && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-secondary">
          <CostValue amount={ignoreStockValueKes} canViewCosts={canViewCosts} className="font-medium" />
          {" of stock sits in locations that count as nothing — is that right? Testers and damaged units belong on a product’s “Not for sale” toggle, not an Ignore location."}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}

      <Card>
        <CardHeader
          title="Locations"
          subtitle={`${rows.length} locations · roles drive cover, transfers, and the buy list`}
        />
        <CardContent className="p-0 pt-4">
          <Table>
            <TableHeader>
              <TableHead>Location</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead numeric>On hand</TableHead>
              <TableHead numeric>Stock value</TableHead>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const selectedType = (row.locationType ?? typeOfRole(row.guessedRole)) as LocationType;
                const role = roleOfType(selectedType);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-ink">
                      <span className="inline-flex items-center gap-2">
                        {row.name}
                        {row.isPrimary && <Badge tone="accent">Primary</Badge>}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <select
                          aria-label={`Role for ${row.name}`}
                          value={selectedType}
                          disabled={!canManage || pending}
                          onChange={(e) =>
                            run(() =>
                              setLocationRole({ locationId: row.id, locationType: e.target.value }),
                            )
                          }
                          className={selectClass}
                        >
                          {ROLE_OPTIONS.map((option) => (
                            <option key={option.type} value={option.type}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <p className="max-w-xs text-xs text-ink-muted">
                          {LOCATION_ROLE_DESCRIPTIONS[role]}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.assumed ? (
                        <Badge tone="warning">Assumed — confirm</Badge>
                      ) : (
                        <Badge tone="positive">Confirmed</Badge>
                      )}
                    </TableCell>
                    <TableCell numeric>{formatNumber(row.unitsOnHand)}</TableCell>
                    <TableCell numeric>
                      <CostValue amount={row.stockValueKes} canViewCosts={canViewCosts} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

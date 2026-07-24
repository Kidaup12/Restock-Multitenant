"use client";

import { useState, useTransition } from "react";
import {
  LOCATION_ROLE_DESCRIPTIONS,
  type LocationType,
  roleOfType,
  typeOfRole,
} from "@wezesha/db";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue, formatNumber } from "@/components/ui/cost-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { setLocationRole, type LocationActionResult } from "./actions";

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

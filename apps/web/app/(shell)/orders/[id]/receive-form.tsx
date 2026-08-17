"use client";

import { useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { receivePoAction } from "../actions";

type ReceiveLine = {
  id: string;
  sku: string;
  title: string;
  quantity: number;
  receivedQty: number;
};

/**
 * Receiving mode: a quantity input per outstanding line (partials welcome),
 * a destination location, one submit. Inputs are clamped client-side to the
 * outstanding remainder; the server re-validates every quantity.
 */
export function ReceiveForm({
  poId,
  lines,
  locations,
}: {
  poId: string;
  lines: ReceiveLine[];
  locations: { id: string; name: string; isPrimary: boolean }[];
}) {
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [locationId, setLocationId] = useState(
    () => locations.find((l) => l.isPrimary)?.id ?? locations[0]?.id ?? ""
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const entries = useMemo(
    () =>
      lines
        .map((line) => ({ lineId: line.id, qty: Number.parseInt(qtys[line.id] ?? "", 10) }))
        .filter((e) => Number.isInteger(e.qty) && e.qty > 0),
    [lines, qtys]
  );
  const receivingUnits = entries.reduce((s, e) => s + e.qty, 0);

  const setQty = (lineId: string, value: string, max: number) => {
    // Clamp to the outstanding remainder; free-typing stays possible below it.
    const parsed = Number.parseInt(value, 10);
    const next = value === "" ? "" : String(Math.max(0, Math.min(max, Number.isNaN(parsed) ? 0 : parsed)));
    setQtys((prev) => ({ ...prev, [lineId]: next }));
  };

  const fillRemaining = () => {
    const next: Record<string, string> = {};
    for (const line of lines) {
      const remaining = line.quantity - line.receivedQty;
      if (remaining > 0) next[line.id] = String(remaining);
    }
    setQtys(next);
  };

  const submit = () => {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await receivePoAction({ poId, locationId, entries });
      if (result.ok) {
        setMessage(result.message ?? null);
        setQtys({});
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div>
      <Table>
        <TableHeader>
          <TableHead>SKU</TableHead>
          <TableHead>Item</TableHead>
          <TableHead numeric>Ordered</TableHead>
          <TableHead numeric>Received</TableHead>
          <TableHead numeric>Receive now</TableHead>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const remaining = line.quantity - line.receivedQty;
            return (
              <TableRow key={line.id}>
                <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                <TableCell className="font-medium text-ink">{line.title}</TableCell>
                <TableCell numeric>{line.quantity}</TableCell>
                <TableCell numeric>
                  {remaining === 0 ? (
                    <Badge tone="positive">All in</Badge>
                  ) : line.receivedQty > 0 ? (
                    `${line.receivedQty}/${line.quantity}`
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell numeric>
                  {remaining === 0 ? (
                    "—"
                  ) : (
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={remaining}
                      placeholder={`0–${remaining}`}
                      value={qtys[line.id] ?? ""}
                      onChange={(e) => setQty(line.id, e.target.value, remaining)}
                      aria-label={`Units received for ${line.title}`}
                    />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="flex items-center gap-2">
          <label htmlFor="receive-location" className="text-sm text-ink-muted">
            Receive into
          </label>
          <Select
            size="sm"
            id="receive-location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.isPrimary ? " (primary)" : ""}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={fillRemaining}>
            Fill remaining
          </Button>
          <Button
            size="sm"
            onClick={submit}
            loading={pending}
            disabled={entries.length === 0 || !locationId}
          >
            Receive {receivingUnits > 0 ? `${receivingUnits} units` : "delivery"}
          </Button>
        </div>
      </div>
      {(message || error) && (
        <p
          className={`px-5 pb-4 text-sm ${error ? "text-negative" : "text-positive"}`}
          role={error ? "alert" : undefined}
        >
          {error ?? message}
        </p>
      )}
    </div>
  );
}

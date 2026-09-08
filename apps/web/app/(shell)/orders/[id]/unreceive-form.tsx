"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { unreceivePoAction } from "../actions";

type BookedLine = {
  id: string;
  sku: string;
  title: string;
  quantity: number;
  receivedQty: number;
};

/**
 * Correcting a receipt that booked in the wrong quantity.
 *
 * Only lines with units actually booked in appear: there is nothing to take
 * back from the others, and offering a box against them invites a number the
 * server would only refuse.
 *
 * It asks which location, defaulting to the primary one exactly as receiving
 * does. A receipt moved stock at one particular place, and taking it back from
 * the wrong shelf would remove units that shelf never gained — so the field is
 * always shown and always changeable, never assumed silently.
 */
export function UnreceiveForm({
  poId,
  lines,
  locations,
}: {
  poId: string;
  lines: BookedLine[];
  locations: { id: string; name: string; isPrimary: boolean }[];
}) {
  const { confirm, dialog } = useConfirm();
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [locationId, setLocationId] = useState(
    () => locations.find((l) => l.isPrimary)?.id ?? locations[0]?.id ?? ""
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const booked = lines.filter((l) => l.receivedQty > 0);

  const entries = useMemo(
    () =>
      booked
        .map((line) => ({ lineId: line.id, qty: Number.parseInt(qtys[line.id] ?? "", 10) }))
        .filter((e) => Number.isInteger(e.qty) && e.qty > 0),
    [booked, qtys]
  );
  const takingBack = entries.reduce((s, e) => s + e.qty, 0);

  const setQty = (lineId: string, value: string, max: number) => {
    // Clamped to what is actually booked in on that line; the server re-checks.
    const parsed = Number.parseInt(value, 10);
    const next =
      value === "" ? "" : String(Math.max(0, Math.min(max, Number.isNaN(parsed) ? 0 : parsed)));
    setQtys((prev) => ({ ...prev, [lineId]: next }));
  };

  const submit = async () => {
    const ok = await confirm({
      title: `Take back ${takingBack} ${takingBack === 1 ? "unit" : "units"}?`,
      body: "This reverses what the delivery added to stock and reopens the order. It is recorded in the activity log.",
      confirmLabel: "Take back",
      cancelLabel: "Leave it",
    });
    if (!ok) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await unreceivePoAction({ poId, locationId, entries });
      if (result.ok) {
        setMessage(result.message ?? null);
        setQtys({});
      } else {
        setError(result.error);
      }
    });
  };

  if (booked.length === 0) return null;

  return (
    <div>
      {dialog}
      <Table>
        <TableHeader>
          <TableHead>SKU</TableHead>
          <TableHead>Item</TableHead>
          <TableHead numeric>Booked in</TableHead>
          <TableHead numeric>Take back</TableHead>
        </TableHeader>
        <TableBody>
          {booked.map((line) => (
            <TableRow key={line.id}>
              <TableCell className="font-mono text-xs">{line.sku}</TableCell>
              <TableCell className="font-medium text-ink">{line.title}</TableCell>
              <TableCell numeric>
                {line.receivedQty}/{line.quantity}
              </TableCell>
              <TableCell numeric>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={line.receivedQty}
                  value={qtys[line.id] ?? ""}
                  onChange={(e) => setQty(line.id, e.target.value, line.receivedQty)}
                  aria-label={`Take back units of ${line.title}`}
                  className="h-9 w-20 rounded-md border border-edge bg-surface px-2 text-right text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-ink-muted" htmlFor="unreceive-location">
          Booked into
        </label>
        <Select
          id="unreceive-location"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          disabled={pending}
        >
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <span className="ml-auto" />
        {error && <span className="text-sm text-negative">{error}</span>}
        {message && <span className="text-sm text-positive">{message}</span>}
        <Button
          size="sm"
          variant="ghost"
          onClick={submit}
          loading={pending}
          disabled={takingBack === 0 || !locationId || pending}
        >
          Take back {takingBack > 0 ? takingBack : ""}
        </Button>
      </div>
    </div>
  );
}

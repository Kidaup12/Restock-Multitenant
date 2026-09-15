"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SpotCheckRow } from "@/lib/data/spot-check";

/**
 * One spot-check row with its count input.
 *
 * A counted row shows the drift instead of an input: the count is recorded, and
 * re-editing it would let the number that catches shrinkage be quietly walked
 * back. Drift is coloured only when it is off — a clean count (drift 0) reads as
 * a plain "matched", not a green success, because "the shelf matched the app"
 * is the expected case, not an achievement.
 *
 * The write goes to /api/spot-check (POST), which re-checks the session, the
 * manage_settings permission and that the row is this workspace's. On success it
 * refreshes the server component so the row flips to its counted state.
 */
export function CountRow({ row, canCount }: { row: SpotCheckRow; canCount: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const counted = Number(value);
    if (value.trim() === "" || !Number.isFinite(counted) || counted < 0) {
      setError("Enter the number you counted.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/spot-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, countedQty: counted }),
      });
      if (!res.ok) {
        setError("Couldn't save that count — please try again in a moment.");
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't save that count — please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-edge">
      <td className="py-3 pr-3">
        <div className="font-medium text-ink">{row.title}</div>
        <div className="text-xs text-ink-muted">{row.sku}</div>
      </td>
      <td className="py-3 pr-3 text-right tabular-nums text-ink">
        {Math.round(row.systemQty)}
      </td>
      {row.countedQty == null ? (
        <>
          <td className="py-3 pr-3">
            {canCount ? (
              <div className="flex items-center justify-end gap-2">
                <Input
                  size="sm"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  aria-label={`Counted quantity for ${row.title}`}
                  aria-invalid={error ? true : undefined}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="max-w-24 text-right"
                  disabled={busy}
                />
                <Button size="sm" onClick={() => void save()} loading={busy}>
                  Save
                </Button>
              </div>
            ) : (
              <span className="block text-right text-xs text-ink-muted">Not counted</span>
            )}
          </td>
          <td className="py-3 text-right text-xs text-ink-muted">—</td>
        </>
      ) : (
        <>
          <td className="py-3 pr-3 text-right tabular-nums text-ink">
            {Math.round(row.countedQty)}
          </td>
          <td className="py-3 text-right tabular-nums">
            <DriftCell drift={row.drift ?? 0} />
          </td>
        </>
      )}
      {error && (
        <td className="py-3 text-right text-xs text-negative" role="status">
          {error}
        </td>
      )}
    </tr>
  );
}

/** Drift = counted − believed. Negative is stock gone missing (red); positive is
 *  stock the app under-counted (amber); zero is a plain match. */
function DriftCell({ drift }: { drift: number }) {
  const rounded = Math.round(drift);
  if (rounded === 0) return <span className="text-ink-muted">Matched</span>;
  const tone = rounded < 0 ? "text-negative" : "text-warning";
  const sign = rounded > 0 ? "+" : "";
  return (
    <span className={tone}>
      {sign}
      {rounded}
    </span>
  );
}

"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useCurrency } from "@/components/currency-provider";
import type { CostImportPreview } from "@/lib/cost";
import { applyCostImportAction, previewCostImportAction, type ApplyResult } from "./actions";

/**
 * Cost upload / paste (spec §4): paste rows or pick a CSV → deterministic
 * preview (matched / ambiguous / unknown / invalid) → apply. Nothing is written
 * until Apply, and a manual pin is only overwritten when the owner confirms it.
 */

const PLACEHOLDER = "sku,cost\nCAN-SHE-340,1100\nNL-GLY-750,320";

export function CostImport({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const currency = useCurrency();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<CostImportPreview | null>(null);
  const [overwritePinned, setOverwritePinned] = useState(false);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setPreview(null);
    setApplied(null);
    setError(null);
  }

  function doPreview() {
    reset();
    start(async () => {
      const res = await previewCostImportAction({ csv });
      if (res.ok) setPreview(res.data!);
      else setError(res.error);
    });
  }

  function doApply() {
    setError(null);
    start(async () => {
      const res = await applyCostImportAction({ csv, overwritePinned });
      if (res.ok) {
        setApplied(res.data!);
        setPreview(null);
        router.refresh();
      } else setError(res.error);
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => {
      setCsv(t);
      reset();
    });
  }

  if (!canManage) {
    return (
      <Card>
        <CardHeader title="Upload costs" subtitle="Paste or upload a cost sheet" />
        <CardContent>
          <p className="text-sm text-ink-muted">You need settings access to import costs.</p>
        </CardContent>
      </Card>
    );
  }

  const s = preview?.summary;

  return (
    <Card>
      <CardHeader
        title="Upload or paste costs"
        subtitle="Land landed cost (supplier price + freight + duty). A cost you type wins over sync."
      />
      <CardContent className="space-y-3">
        <textarea
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            reset();
          }}
          rows={5}
          placeholder={PLACEHOLDER}
          className="w-full rounded-md border border-edge bg-surface p-3 font-mono text-xs text-ink outline-accent focus-visible:outline-2"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="hidden" />
          <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
            Choose CSV…
          </Button>
          <Button size="sm" onClick={doPreview} loading={pending} disabled={!csv.trim()}>
            Preview
          </Button>
        </div>

        {error && <p className="text-sm text-negative">{error}</p>}

        {applied && (
          <div className="rounded-md border border-positive/40 bg-positive-soft/40 p-3 text-sm text-ink">
            Applied {applied.applied} cost{applied.applied === 1 ? "" : "s"}.
            {applied.pinnedSkipped > 0 && ` Kept ${applied.pinnedSkipped} typed cost${applied.pinnedSkipped === 1 ? "" : "s"} (tick overwrite to replace).`}
            {applied.ambiguous + applied.unknown + applied.invalid > 0 &&
              ` Skipped ${applied.ambiguous} ambiguous, ${applied.unknown} unknown, ${applied.invalid} invalid.`}
          </div>
        )}

        {s && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone="positive">{s.matched} matched</Badge>
              {s.pinned > 0 && <Badge tone="warning">{s.pinned} already typed</Badge>}
              {s.ambiguous > 0 && <Badge tone="warning">{s.ambiguous} ambiguous</Badge>}
              {s.unknown > 0 && <Badge tone="neutral">{s.unknown} unknown</Badge>}
              {s.invalid > 0 && <Badge tone="neutral">{s.invalid} invalid</Badge>}
            </div>

            <div className="max-h-72 overflow-auto rounded-md border border-edge">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-2 text-2xs tracking-wider text-ink-muted uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Row</th>
                    <th className="px-3 py-2 text-left">Match</th>
                    <th className="px-3 py-2 text-right">Cost ({currency})</th>
                    <th className="px-3 py-2 text-left">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {preview!.rows.map((r) => (
                    <tr key={r.rowNumber} className="border-t border-edge">
                      <td className="px-3 py-1.5 text-ink-muted">{r.sku ?? r.name ?? `#${r.rowNumber}`}</td>
                      <td className="px-3 py-1.5 text-ink">{r.title ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.costKes != null ? r.costKes.toLocaleString("en-KE") : "—"}</td>
                      <td className="px-3 py-1.5">
                        <span className="text-2xs text-ink-muted">
                          {r.status === "matched" ? (r.pinned ? "matched · typed" : "matched") : r.status}
                          {r.note ? ` — ${r.note}` : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {s.pinned > 0 && (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={overwritePinned}
                    onChange={(e) => setOverwritePinned(e.target.checked)}
                    className="size-4 accent-[var(--accent)]"
                  />
                  Overwrite {s.pinned} typed cost{s.pinned === 1 ? "" : "s"}
                </label>
              )}
              <Button size="sm" onClick={doApply} loading={pending} disabled={s.matched === 0}>
                Apply {overwritePinned ? s.matched : s.matched - s.pinned} cost{(overwritePinned ? s.matched : s.matched - s.pinned) === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

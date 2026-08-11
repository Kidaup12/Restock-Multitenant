"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { rowsToCsv } from "@/lib/export/csv";
import { TEMPLATE_HEADERS, type SupplierImportPreview } from "@/lib/suppliers/import";
import {
  applySupplierImportAction,
  previewSupplierImportAction,
  type SupplierImportResult,
} from "./actions";

/**
 * Supplier CSV import: paste rows or pick a file → preview every row → apply.
 * Nothing is written until Apply, and the server re-runs the same preview before
 * it writes, so what the table showed is what lands.
 */

const PLACEHOLDER =
  "Name,Country,Currency,Lead time,MOQ\nWestgate Distributors,Kenya,KES,14,24\nCanton Supply,China,USD,35,48";

const STATUS_LABEL: Record<string, string> = {
  create: "new",
  update: "updates an existing supplier",
  repeat: "repeat",
  invalid: "skipped",
};

export function SupplierImport({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<SupplierImportPreview | null>(null);
  const [applied, setApplied] = useState<SupplierImportResult | null>(null);
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
      const res = await previewSupplierImportAction({ csv });
      if (res.ok) setPreview(res.data!);
      else setError(res.error);
    });
  }

  function doApply() {
    setError(null);
    start(async () => {
      const res = await applySupplierImportAction({ csv });
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

  function downloadTemplate() {
    const text = rowsToCsv(TEMPLATE_HEADERS, [
      ["Westgate Distributors", "orders@westgate.co.ke", "Kenya", "KES", "Local", 14, 3, 24, ""],
    ]);
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "supplier-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const s = preview?.summary;
  const applicable = s ? s.create + s.update : 0;

  return (
    <Card>
      <CardHeader
        title="Import suppliers"
        subtitle="One row per supplier. A name that matches one you already have updates it — blank cells are left as they are."
        action={
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
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
          aria-label="Supplier rows"
          className="w-full rounded-md border border-edge bg-surface p-3 font-mono text-xs text-ink outline-accent focus-visible:outline-2"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={onFile}
            className="hidden"
          />
          <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
            Choose CSV…
          </Button>
          <Button size="sm" variant="ghost" onClick={downloadTemplate}>
            Download template
          </Button>
          <Button size="sm" onClick={doPreview} loading={pending} disabled={!csv.trim()}>
            Preview
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}

        {applied && (
          <div className="rounded-md border border-positive/40 bg-positive-soft/40 p-3 text-sm text-ink">
            Added {applied.created} supplier{applied.created === 1 ? "" : "s"}
            {applied.updated > 0 && `, updated ${applied.updated}`}.
            {applied.invalid + applied.repeat > 0 &&
              ` Skipped ${applied.invalid + applied.repeat} row${applied.invalid + applied.repeat === 1 ? "" : "s"}: ${applied.invalid} unusable, ${applied.repeat} repeated.`}
          </div>
        )}

        {s && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone="positive">{s.create} new</Badge>
              {s.update > 0 && <Badge tone="accent">{s.update} to update</Badge>}
              {s.repeat > 0 && <Badge tone="warning">{s.repeat} repeated</Badge>}
              {s.invalid > 0 && <Badge tone="neutral">{s.invalid} skipped</Badge>}
            </div>

            <div className="max-h-72 overflow-auto rounded-md border border-edge">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-2 text-xs text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Supplier</th>
                    <th className="px-3 py-2 text-right">Lead (d)</th>
                    <th className="px-3 py-2 text-right">MOQ</th>
                    <th className="px-3 py-2 text-left">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {preview!.rows.map((r) => (
                    <tr key={r.rowNumber} className="border-t border-edge">
                      <td className="px-3 py-1.5 text-ink">{r.name ?? `#${r.rowNumber}`}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {r.data?.leadTimeAvgDays ?? "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.data?.moq ?? "—"}</td>
                      <td className="px-3 py-1.5">
                        <span className="text-xs text-ink-muted">
                          {STATUS_LABEL[r.status] ?? r.status}
                          {r.note ? ` — ${r.note}` : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Button size="sm" onClick={doApply} loading={pending} disabled={applicable === 0}>
              Import {applicable} supplier{applicable === 1 ? "" : "s"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

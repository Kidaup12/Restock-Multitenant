"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { exportSectionPdf, type PdfColumn } from "@/lib/export/print-pdf";

/**
 * "Export PDF" for one Insights table — the branded, server-rendered counterpart
 * to the CSV export. The server component hands over the exact columns and rows
 * it just rendered, so the download matches the screen (and its cost redaction)
 * by construction; the button only ships them to /api/reports/section-pdf and
 * saves the blob.
 *
 * Own busy/error state rather than a toast, mirroring the check-now button on
 * this page — the app has no toast bridge.
 */
export function ExportPdfButton({
  title,
  subtitle,
  columns,
  rows,
  note,
}: {
  title: string;
  subtitle?: string;
  columns: PdfColumn[];
  rows: (string | number | null | undefined)[][];
  note?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    setBusy(true);
    setFailed(false);
    const ok = await exportSectionPdf({ title, subtitle, columns, rows, note });
    setFailed(!ok);
    setBusy(false);
  }

  return (
    <div className="flex items-center gap-2">
      {failed && (
        <span role="status" className="text-xs text-ink-muted">
          Couldn&apos;t build the PDF — try again.
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void run()}
        loading={busy}
        disabled={rows.length === 0}
      >
        Export PDF
      </Button>
    </div>
  );
}

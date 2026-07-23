"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { rowsToCsv, rowsToTsv, timestampedFilename, type CellValue } from "./csv";
import { printDocument } from "./pdf";

/**
 * "Export what you see": CSV download, clipboard copy (TSV — pastes straight
 * into a spreadsheet), and an optional printable document (browser save-as-PDF).
 *
 * The component takes the live row array, so whatever filter produced those
 * rows is honoured by construction — screens never re-derive export state.
 * Generic on purpose: the Plan buy list is the first consumer; Stock and Sales
 * adopt it by declaring their own columns.
 */

export type ExportColumn<T> = {
  header: string;
  cell: (row: T) => CellValue;
};

export function ExportBar<T>({
  rows,
  columns,
  filename,
  document: printable,
  className,
}: {
  /** The rows currently visible under the active filter. */
  rows: readonly T[];
  columns: readonly ExportColumn<T>[];
  /** Base filename, no extension — the download is date-stamped. */
  filename: string;
  /** When set, adds a "Save PDF" button printing these rows as a document. */
  document?: { title: string; subtitle?: string; footNote?: string };
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const headers = columns.map((c) => c.header);
  const matrix = () => rows.map((row) => columns.map((c) => c.cell(row)));

  function downloadCsv() {
    const url = URL.createObjectURL(
      new Blob([rowsToCsv(headers, matrix())], { type: "text/csv;charset=utf-8" })
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = timestampedFilename(filename, "csv");
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function copyTsv() {
    await navigator.clipboard.writeText(rowsToTsv(headers, matrix()));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  function savePdf() {
    if (!printable) return;
    printDocument({
      ...printable,
      columns: headers,
      // Strings for print: numbers keep their own formatting via cell type.
      rows: matrix().map((row) => row.map((cell) => (cell == null ? "" : cell))),
    });
  }

  const empty = rows.length === 0;
  return (
    <div className={className ? `flex items-center gap-2 ${className}` : "flex items-center gap-2"}>
      <Button variant="ghost" size="sm" disabled={empty} onClick={downloadCsv}>
        Export CSV
      </Button>
      <Button variant="ghost" size="sm" disabled={empty} onClick={copyTsv}>
        {copied ? "Copied" : "Copy"}
      </Button>
      {printable && (
        <Button variant="ghost" size="sm" disabled={empty} onClick={savePdf}>
          Save PDF
        </Button>
      )}
    </div>
  );
}

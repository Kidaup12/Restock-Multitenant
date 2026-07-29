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
  loadRows,
  count,
  columns,
  filename,
  document: printable,
  className,
}: {
  /** The rows currently visible under the active filter. Omit when the screen
   *  only holds a page of them and passes `loadRows` instead. */
  rows?: readonly T[];
  /** Fetch the full matched list at click time. A screen that pages its table
   *  cannot hand over what it does not hold, and an export of "the fifty rows
   *  you happen to be looking at" is the wrong file. */
  loadRows?: () => Promise<readonly T[]>;
  /** How many rows the export will contain, when `loadRows` supplies them —
   *  the buttons still need to know whether there is anything to export. */
  count?: number;
  columns: readonly ExportColumn<T>[];
  /** Base filename, no extension — the download is date-stamped. */
  filename: string;
  /** When set, adds a "Save PDF" button printing these rows as a document. */
  document?: { title: string; subtitle?: string; footNote?: string };
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const headers = columns.map((c) => c.header);
  const resolve = async (): Promise<readonly T[]> => (loadRows ? await loadRows() : (rows ?? []));
  const matrixOf = (list: readonly T[]) => list.map((row) => columns.map((c) => c.cell(row)));

  /** Serialises the click so a slow fetch can't start a second one, and so the
   *  buttons read as busy rather than dead. */
  async function run(job: (list: readonly T[]) => void | Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await job(await resolve());
    } finally {
      setBusy(false);
    }
  }

  const downloadCsv = () =>
    run((list) => {
      const url = URL.createObjectURL(
        new Blob([rowsToCsv(headers, matrixOf(list))], { type: "text/csv;charset=utf-8" })
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = timestampedFilename(filename, "csv");
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

  const copyTsv = () =>
    run(async (list) => {
      await navigator.clipboard.writeText(rowsToTsv(headers, matrixOf(list)));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });

  const savePdf = () =>
    run((list) => {
      if (!printable) return;
      printDocument({
        ...printable,
        columns: headers,
        // Strings for print: numbers keep their own formatting via cell type.
        rows: matrixOf(list).map((row) => row.map((cell) => (cell == null ? "" : cell))),
      });
    });

  const empty = (count ?? rows?.length ?? 0) === 0;
  const disabled = empty || busy;
  return (
    <div className={className ? `flex items-center gap-2 ${className}` : "flex items-center gap-2"}>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={downloadCsv}>
        Export CSV
      </Button>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={copyTsv}>
        {copied ? "Copied" : "Copy"}
      </Button>
      {printable && (
        <Button variant="ghost" size="sm" disabled={disabled} onClick={savePdf}>
          Save PDF
        </Button>
      )}
    </div>
  );
}

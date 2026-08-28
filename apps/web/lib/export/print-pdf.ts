/**
 * "Export this section as a PDF" — posts the on-screen table to the server, which
 * renders a branded report (react-pdf) and streams it back as a real PDF
 * download. A companion to the browser-print path in pdf.ts: this one produces a
 * pixel-consistent branded document rather than a print dialog.
 *
 * Tenant is resolved from the session server-side (see /api/reports/section-pdf),
 * so the fetch carries no tenant header — the same way every other client fetch
 * in this app reaches its /api routes. Returns whether the download started so a
 * button can surface its own error, since this app has no toast bridge.
 *
 * Client-only (touches the DOM).
 */

export type PdfColumn = { header: string; width?: number; align?: "left" | "right" };

/** Build columns from a header list + the indexes that should right-align (numbers). */
export function cols(headers: string[], rightAlign: number[] = []): PdfColumn[] {
  const r = new Set(rightAlign);
  return headers.map((h, i) => ({ header: h, align: r.has(i) ? "right" : "left" }));
}

/** Slugify a title into a safe filename stem, matching the server's own rule. */
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}

export async function exportSectionPdf(opts: {
  title: string;
  subtitle?: string;
  kpis?: { label: string; value: string }[];
  columns: PdfColumn[];
  rows: (string | number | null | undefined)[][];
  note?: string;
}): Promise<boolean> {
  try {
    const res = await fetch("/api/reports/section-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) return false;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(opts.title)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

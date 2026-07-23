/**
 * "Documents as PDF" via the browser's print-to-PDF pipeline.
 *
 * Mechanism: render the document into a hidden same-origin iframe and call
 * print() on it — the user saves it as a PDF from the print dialog. Chosen over
 * a PDF library because it is dependency-free (no ~1.5MB renderer in the
 * bundle, no font embedding), produces real selectable-text PDFs, and prints
 * exactly the rows the caller passes — the active filter stays honoured by
 * construction. Tradeoff: the user picks "Save as PDF" in the dialog and
 * browser print headers vary; if pixel-identical server-generated documents
 * become a requirement, a renderer can replace this behind the same call.
 *
 * Client-only (touches the DOM).
 */

export type PrintCell = string | number | boolean | null | undefined;

export type PrintTableDocument = {
  /** Document heading; also the suggested filename in the save dialog. */
  title: string;
  subtitle?: string;
  columns: readonly string[];
  rows: readonly (readonly PrintCell[])[];
  /** Line under the table, e.g. a total. */
  footNote?: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cellHtml(cell: PrintCell): string {
  const numeric = typeof cell === "number";
  const text = cell == null ? "" : String(cell);
  return `<td class="${numeric ? "num" : ""}">${escapeHtml(text)}</td>`;
}

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 18px; margin: 0; }
  p.sub { margin: 4px 0 0; color: #555; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  thead { display: table-header-group; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #555; border-bottom: 1px solid #999; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr { break-inside: avoid; }
  p.foot { margin-top: 12px; font-weight: 600; }
  @page { margin: 14mm; }
`;

export function documentHtml(doc: PrintTableDocument): string {
  const head = doc.columns
    .map((c, i) => {
      const numericColumn = doc.rows.every(
        (row) => row[i] == null || typeof row[i] === "number"
      );
      return `<th class="${numericColumn && doc.rows.length > 0 ? "num" : ""}">${escapeHtml(c)}</th>`;
    })
    .join("");
  const body = doc.rows
    .map((row) => `<tr>${row.map(cellHtml).join("")}</tr>`)
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title>` +
    `<style>${PRINT_STYLES}</style></head><body>` +
    `<h1>${escapeHtml(doc.title)}</h1>` +
    (doc.subtitle ? `<p class="sub">${escapeHtml(doc.subtitle)}</p>` : "") +
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
    (doc.footNote ? `<p class="foot">${escapeHtml(doc.footNote)}</p>` : "") +
    `</body></html>`
  );
}

/** Open the print dialog on the rendered document (browser "Save as PDF"). */
export function printDocument(doc: PrintTableDocument): void {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");

  const cleanup = () => iframe.remove();
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) return cleanup();
    win.addEventListener("afterprint", cleanup);
    win.focus();
    win.print();
    // Fallback for browsers that never fire afterprint inside an iframe.
    window.setTimeout(cleanup, 60_000);
  };
  iframe.srcdoc = documentHtml(doc);
  document.body.appendChild(iframe);
}

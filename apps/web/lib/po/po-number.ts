/**
 * Sequential, collision-proof PO numbers ("PO-0042").
 *
 * The next number is derived from the MAX numeric suffix of the existing plain
 * `PO-####` numbers — never `count()+1`, which collides after a deletion gap or
 * when a differently-formatted series (date-prefixed imports) inflates the
 * count. The tenant's `poNumberFloor` seeds the sequence so numbering carries
 * on from an external system's current max (e.g. the accounting package).
 *
 * Pure so it unit-tests without a database; the caller supplies the existing
 * numbers and serialises creation (advisory lock) so max+1 stays race-free.
 */

// Plain series only. An optional letter suffix (e.g. "PO-0109WEZ" from an
// import) still counts toward the max; date-prefixed "PO-20260605-0068" is a
// different series and is ignored.
const PLAIN_PO = /^PO-(\d{1,9})(?:[A-Z]{1,5})?$/i;

export function nextPoNumber(existing: string[], floor = 0): string {
  let max = Math.max(0, Math.floor(floor) || 0);
  for (const n of existing) {
    const m = PLAIN_PO.exec(n.trim());
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return `PO-${String(max + 1).padStart(4, "0")}`;
}

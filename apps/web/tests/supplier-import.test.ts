import { describe, expect, it } from "vitest";
import {
  applicableSupplierWrites,
  previewSupplierImport,
  IMPORT_ROW_MAX,
  type ImportSupplier,
  type SupplierImportPreview,
} from "@/lib/suppliers/import";

/**
 * Supplier CSV preview → apply — deterministic and pure. Nothing writes; the
 * preview decides each row (create / update / repeat / invalid) against the
 * suppliers passed in, and applicableSupplierWrites derives the write plan.
 */

const EXISTING: ImportSupplier[] = [
  { id: "s1", name: "Westgate Distributors" },
  { id: "s2", name: "Canton Supply Co." },
];

function preview(csv: string, existing: ImportSupplier[] = EXISTING): SupplierImportPreview {
  const r = previewSupplierImport(csv, existing);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("previewSupplierImport", () => {
  it("creates a supplier that isn't on file yet", () => {
    const p = preview("Name,Country,Currency,Lead time,MOQ\nNairobi Beauty,Kenya,KES,10,12");
    expect(p.rows[0]).toMatchObject({ status: "create", supplierId: null, rowNumber: 1 });
    expect(p.rows[0]!.data).toMatchObject({
      name: "Nairobi Beauty",
      country: "Kenya",
      currency: "KES",
      leadTimeAvgDays: 10,
      moq: 12,
    });
    expect(p.summary).toMatchObject({ total: 1, create: 1, update: 0 });
  });

  it("matches an existing supplier on the normalised name, not the exact string", () => {
    const p = preview("name,lead time\n  westgate  distributors ,21");
    expect(p.rows[0]).toMatchObject({ status: "update", supplierId: "s1" });
    expect(p.summary.update).toBe(1);
  });

  it("matches through punctuation the owner typed differently", () => {
    const p = preview("name,moq\nCanton Supply Co,60");
    expect(p.rows[0]).toMatchObject({ status: "update", supplierId: "s2" });
  });

  it("treats a soft-deleted supplier as absent — the caller passes live rows only", () => {
    const p = preview("name\nWestgate Distributors", []);
    expect(p.rows[0]!.status).toBe("create");
  });

  it("folds a repeat of the same name in one file into the first row", () => {
    const p = preview("name,moq\nNairobi Beauty,12\nnairobi beauty,99");
    expect(p.rows.map((r) => r.status)).toEqual(["create", "repeat"]);
    expect(p.summary).toMatchObject({ create: 1, repeat: 1 });
    // The repeat never becomes a second supplier.
    expect(applicableSupplierWrites(p)).toHaveLength(1);
  });

  it("folds a repeated update too, so one supplier is written once", () => {
    const p = preview("name,moq\nWestgate Distributors,24\nWestgate Distributors,48");
    expect(p.rows.map((r) => r.status)).toEqual(["update", "repeat"]);
    const writes = applicableSupplierWrites(p);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "update", supplierId: "s1" });
    expect(writes[0]!.data.moq).toBe(24);
  });

  it("leaves a blank cell null rather than inventing a lead time", () => {
    const p = preview("name,lead time,moq\nNairobi Beauty,,12");
    expect(p.rows[0]!.data).toMatchObject({ leadTimeAvgDays: null, moq: 12 });
  });

  it("leaves currency null when the file has no currency column", () => {
    const p = preview("name\nNairobi Beauty");
    expect(p.rows[0]!.data!.currency).toBeNull();
  });

  it("rejects a currency the workspace doesn't accept", () => {
    const p = preview("name,currency\nNairobi Beauty,GBP");
    expect(p.rows[0]!.status).toBe("invalid");
    expect(p.rows[0]!.note).toContain("GBP");
  });

  it("rejects out-of-range and non-numeric numbers instead of coercing them", () => {
    const p = preview(
      "name,lead time,moq\nA Ltd,400,1\nB Ltd,10,0\nC Ltd,soon,1\nD Ltd,14,2"
    );
    expect(p.rows.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid", "create"]);
    expect(p.summary.invalid).toBe(3);
  });

  it("skips a row with no name", () => {
    const p = preview("name,moq\n,12\nNairobi Beauty,12");
    expect(p.rows[0]).toMatchObject({ status: "invalid", name: null });
    expect(p.rows[1]!.status).toBe("create");
  });

  it("does not let the short 'lead time' alias claim the variability column", () => {
    const p = preview("name,lead time,lead time variability\nNairobi Beauty,14,3");
    expect(p.rows[0]!.data).toMatchObject({ leadTimeAvgDays: 14, leadTimeStdDays: 3 });
  });

  it("reads the columns in whatever order the spreadsheet had them", () => {
    const p = preview("MOQ,Supplier,Email\n24,Nairobi Beauty,orders@nb.co.ke");
    expect(p.rows[0]!.data).toMatchObject({
      name: "Nairobi Beauty",
      moq: 24,
      email: "orders@nb.co.ke",
    });
  });

  it("needs a name column", () => {
    const r = previewSupplierImport("country,moq\nKenya,12", EXISTING);
    expect("error" in r && r.error).toContain("name column");
  });

  it("needs at least one data row", () => {
    const r = previewSupplierImport("name,moq", EXISTING);
    expect("error" in r).toBe(true);
  });

  it("refuses a file past the row cap rather than half-importing it", () => {
    const csv = ["name", ...Array.from({ length: IMPORT_ROW_MAX + 1 }, (_, i) => `S${i}`)].join("\n");
    const r = previewSupplierImport(csv, EXISTING);
    expect("error" in r && r.error).toContain(String(IMPORT_ROW_MAX));
  });
});

describe("applicableSupplierWrites", () => {
  it("drops invalid rows and keeps file order", () => {
    const p = preview("name,moq\nNairobi Beauty,12\n,5\nWestgate Distributors,24");
    const writes = applicableSupplierWrites(p);
    expect(writes.map((w) => w.kind)).toEqual(["create", "update"]);
  });

  it("is idempotent in shape: re-importing the same file only updates", () => {
    const first = preview("name,moq\nNairobi Beauty,12");
    expect(applicableSupplierWrites(first)[0]!.kind).toBe("create");
    // Second run, with the supplier now saved.
    const second = preview("name,moq\nNairobi Beauty,12", [
      ...EXISTING,
      { id: "s3", name: "Nairobi Beauty" },
    ]);
    const writes = applicableSupplierWrites(second);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "update", supplierId: "s3" });
  });
});

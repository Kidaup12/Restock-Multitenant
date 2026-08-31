import { describe, expect, it, vi } from "vitest";
import { QuickBooksApiError, fetchPurchaseOrders } from "../src/purchase-orders";

/** A response Intuit would send, without pulling in a real HTTP stack. */
function reply(orders: unknown[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ QueryResponse: { PurchaseOrder: orders } }),
  } as unknown as Response;
}

const doc = (over: Record<string, unknown> = {}) => ({
  Id: "1",
  DocNumber: "PO-1001",
  TotalAmt: 10_000,
  TxnDate: "2026-08-21",
  VendorRef: { value: "7", name: "Amara Supplies" },
  ...over,
});

const BASE = "https://sandbox.example";
const args = { accessToken: "tok", realmId: "realm-1", since: new Date("2026-08-01"), baseUrl: BASE };

describe("reading purchase orders from a company", () => {
  it("asks the right company, with the token and the date bound", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([doc()]));
    await fetchPurchaseOrders({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/v3/company/realm-1/query");
    expect(decodeURIComponent(url as string)).toContain("TxnDate >= '2026-08-01'");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("maps only the fields matching needs, and trims them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([doc({ DocNumber: "  PO-1001  " })]));
    const [row] = await fetchPurchaseOrders({
      ...args,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(row).toEqual({
      id: "1",
      docNumber: "PO-1001",
      totalAmt: 10_000,
      txnDate: "2026-08-21",
      vendorName: "Amara Supplies",
    });
  });

  it("drops a document with no id — there is nothing to record as evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([doc({ Id: undefined })]));
    const rows = await fetchPurchaseOrders({
      ...args,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(rows).toEqual([]);
  });

  it("keeps paging while pages come back full, and stops on a short one", async () => {
    const full = Array.from({ length: 100 }, (_, i) => doc({ Id: String(i + 1) }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(full))
      .mockResolvedValueOnce(reply([doc({ Id: "101" })]));

    const rows = await fetchPurchaseOrders({
      ...args,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(rows).toHaveLength(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(fetchImpl.mock.calls[1]![0] as string)).toContain("STARTPOSITION 101");
  });

  it("stops at maxPages rather than paging a large company forever", async () => {
    const full = Array.from({ length: 100 }, (_, i) => doc({ Id: String(i + 1) }));
    const fetchImpl = vi.fn().mockResolvedValue(reply(full));

    const rows = await fetchPurchaseOrders({
      ...args,
      maxPages: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Partial evidence, not an error: it still confirms what it covers, and the
    // next tick starts from the same place.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(300);
  });

  it("marks a 401 as unauthorized so the caller reconnects instead of retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([], 401));
    await expect(
      fetchPurchaseOrders({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "QuickBooksApiError", unauthorized: true });
  });

  it("treats other failures as retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([], 503));
    const err = await fetchPurchaseOrders({
      ...args,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuickBooksApiError);
    expect((err as QuickBooksApiError).unauthorized).toBe(false);
  });
});

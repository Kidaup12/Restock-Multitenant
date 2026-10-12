import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  membership: { tenantId: "t1", role: "OWNER", permissions: null, displayName: "Owner" },
  product: vi.fn(), promo: vi.fn(), dismissal: vi.fn(), audit: vi.fn(), revalidate: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireSession: async () => ({ user: { id: "u1", name: "Owner", email: "owner@example.test" } }), activeMembership: async () => mocks.membership }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@wezesha/db", () => ({ prismaForTenant: () => ({ product: { findFirst: mocks.product }, promo: { create: mocks.promo }, ignoreRule: { upsert: mocks.dismissal } }), prismaService: { auditEvent: { create: mocks.audit } } }));
vi.mock("@wezesha/pos", () => ({ dayMarker: (key: string) => new Date(`${key}T00:00:00Z`) }));
import { dismissSpike, logSpikeAsPromo } from "../app/(shell)/settings/signals/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership.role = "OWNER";
  mocks.product.mockResolvedValue({ id: "p1", sku: "SER", title: "Serum" });
  mocks.promo.mockResolvedValue({ id: "promo1" });
  mocks.dismissal.mockResolvedValue({});
  mocks.audit.mockResolvedValue({});
});

describe("sales review actions", () => {
  it("persists a tenant/product/day dismissal without creating a promotion", async () => {
    const result = await dismissSpike({ productId: "p1", dayKey: "2026-10-04" });
    expect(result).toMatchObject({ ok: true });
    expect(mocks.dismissal).toHaveBeenCalledWith(expect.objectContaining({ create: { tenantId: "t1", kind: "spike_day", value: "p1:2026-10-04" } }));
    expect(mocks.promo).not.toHaveBeenCalled();
    for (const route of ["/settings/signals", "/today", "/sales", "/products/p1"]) expect(mocks.revalidate).toHaveBeenCalledWith(route);
  });
  it("records a real offer against only the selected SKU and audits it", async () => {
    expect(await logSpikeAsPromo({ productId: "p1", dayKey: "2026-10-04" })).toMatchObject({ ok: true });
    expect(mocks.promo).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1", scope: "sku", scopeValue: "SER" }) }));
    expect(mocks.audit).toHaveBeenCalled();
  });
  it("denies writes by members without settings permission", async () => {
    mocks.membership.role = "MEMBER";
    expect(await dismissSpike({ productId: "p1", dayKey: "2026-10-04" })).toMatchObject({ ok: false });
    expect(await logSpikeAsPromo({ productId: "p1", dayKey: "2026-10-04" })).toMatchObject({ ok: false });
    expect(mocks.product).not.toHaveBeenCalled();
    expect(mocks.dismissal).not.toHaveBeenCalled();
    expect(mocks.promo).not.toHaveBeenCalled();
  });
  it("does not act on an id absent from the caller's tenant", async () => {
    mocks.product.mockResolvedValue(null);
    expect(await dismissSpike({ productId: "foreign", dayKey: "2026-10-04" })).toMatchObject({ ok: false });
    expect(mocks.dismissal).not.toHaveBeenCalled();
  });
});

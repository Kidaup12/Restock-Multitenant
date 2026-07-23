import { prismaService } from "../src/client";

/**
 * Two-tenant fixture for the isolation suite. Every tenant-scoped model MUST
 * have a data builder here — the suite cross-checks this list against the
 * Prisma DMMF and fails loudly when a new model is missing, so coverage cannot
 * rot silently.
 *
 * A builder returns a valid `create` data object for the given tenant. The
 * `key` suffix keeps unique fields collision-free when the suite creates extra
 * rows (e.g. the cross-tenant WITH CHECK probe).
 */
export const SLUG_A = "iso-test-a";
export const SLUG_B = "iso-test-b";

type Builder = (tenantId: string, key: string) => Record<string, unknown>;

export const builders: Record<string, Builder> = {
  Membership: (tenantId, key) => ({
    tenantId,
    userId: `00000000-0000-4000-8000-${key.padStart(12, "0")}`,
    role: "OWNER",
    displayName: `member-${key}`,
  }),
  TenantConfig: (tenantId) => ({
    tenantId,
    alertEmail: "alerts@example.test",
  }),
};

export type SeededTenants = { a: { id: string; slug: string }; b: { id: string; slug: string } };

/** Drop and recreate both fixture tenants plus one row of every scoped model. */
export async function seedTwoTenants(): Promise<SeededTenants> {
  await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  const a = await prismaService.tenant.create({ data: { name: "Iso Test A", slug: SLUG_A } });
  const b = await prismaService.tenant.create({ data: { name: "Iso Test B", slug: SLUG_B } });

  let n = 0;
  for (const [model, build] of Object.entries(builders)) {
    const delegate = (prismaService as unknown as Record<string, { create: (a: { data: unknown }) => Promise<unknown> } | undefined>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ];
    if (!delegate) throw new Error(`no client delegate for model ${model} — regenerate the client?`);
    await delegate.create({ data: build(a.id, `a${n}`) });
    await delegate.create({ data: build(b.id, `b${n}`) });
    n++;
  }
  return { a: { id: a.id, slug: a.slug }, b: { id: b.id, slug: b.slug } };
}

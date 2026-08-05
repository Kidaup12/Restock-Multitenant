import { prismaForTenantTx } from "@wezesha/db";

/**
 * The state behind each Settings section, so the hub says what is actually set
 * up instead of only describing what each screen is for.
 *
 * A settings page that reads "Connections — connect your Shopify store" tells an
 * owner nothing about whether theirs IS connected; they have to open all six
 * screens to find out. The reference build answers that on the page itself.
 *
 * All six reads share one connection: through the per-operation tenant client
 * each would open its own transaction and ask the pool for a connection of its
 * own (see packages/db on why that starves under a small pool).
 */

export type SettingsOverview = {
  teamMembers: number;
  locations: number;
  /** Promotions and closure days declared — the days that weren't normal trading. */
  signals: number;
  /** Latest forecast run, or null when none has run for this workspace. */
  lastForecastRun: Date | null;
  /** Whether till sales have ever arrived — the POS feed is configured elsewhere,
   *  but "have we ever seen one" is the question the owner is really asking. */
  hasTillSales: boolean;
};

export async function getSettingsOverview(tenantId: string): Promise<SettingsOverview> {
  return prismaForTenantTx(
    tenantId,
    async (tx) => ({
      teamMembers: await tx.membership.count(),
      locations: await tx.location.count(),
      signals: (await tx.promo.count({ where: { deletedAt: null } })) +
        (await tx.locationClosure.count()),
      lastForecastRun:
        (await tx.prediction.findFirst({ orderBy: { runDate: "desc" }, select: { runDate: true } }))
          ?.runDate ?? null,
      hasTillSales: (await tx.posSale.count()) > 0,
    }),
    { maxWait: 10_000, timeout: 30_000 }
  );
}

import { prismaService, type ShopifyConnection } from "@wezesha/db";

/**
 * The sanctioned NON-SESSION tenant resolver. Webhooks arrive with no session —
 * the shop domain IS the tenant key (ShopifyConnection.shopDomain is globally
 * unique). This is the one place a service-client lookup may run without a
 * tenantId filter; session-backed paths must resolve tenants through
 * requireSession + activeMembership instead.
 */
export function connectionByShopDomain(shopDomain: string): Promise<ShopifyConnection | null> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- shopDomain IS the tenant key here; there is no tenantId to filter on until this lookup returns one.
  return prismaService.shopifyConnection.findUnique({ where: { shopDomain } });
}

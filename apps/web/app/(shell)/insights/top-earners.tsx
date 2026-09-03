import { getTopProducts } from "@/lib/data/sales";
import { TopEarnersView } from "./top-earners-view";

/**
 * The shop's best earners, on the Reports screen where a person looks for them.
 *
 * This ranking already existed on the Sales-data page; what a report needs and
 * that screen lacked is the CLASS lens — "show me my top A-class earners" — so
 * an owner can see whether the products meant to carry the shop actually are.
 * The list is the same getter, extended once to carry each row's ABC class; the
 * filtering is on the client, over the twelve rows already fetched, so choosing
 * a class costs no round trip.
 */
export async function TopEarners({
  tenantId,
  currency,
}: {
  tenantId: string;
  currency: string;
}) {
  // A few more than the ten shown, so filtering to one class still fills the
  // list rather than leaving three rows under an A-class chip.
  const rows = await getTopProducts(tenantId, { days: 30, limit: 24 });
  return <TopEarnersView rows={rows} currency={currency} />;
}

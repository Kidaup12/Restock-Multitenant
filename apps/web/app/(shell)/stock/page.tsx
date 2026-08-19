import { permanentRedirect } from "next/navigation";
import type { RawSearchParams } from "@/lib/catalogue";

/**
 * `/stock` was one screen with a tab; it is now Products and Inventory. The
 * route stays as a forwarder because it shipped, and a bookmark or a link in
 * somebody's notes should not answer 404. The by-location tab becomes Inventory;
 * everything else was the catalogue.
 *
 * Filters ride along so a saved link to a filtered catalogue still lands on the
 * rows it named.
 */
export default async function StockRedirect({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  if (params.view === "locations") permanentRedirect("/inventory");

  const carried = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "view") continue;
    for (const v of Array.isArray(value) ? value : value == null ? [] : [value]) {
      carried.append(key, v);
    }
  }
  const query = carried.toString();
  permanentRedirect(query ? `/products?${query}` : "/products");
}

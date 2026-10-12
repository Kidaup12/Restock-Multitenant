import type { UnsoldReason } from "@/lib/data/today";

export const UNSOLD_STATUS_LABELS: Record<UnsoldReason, string> = {
  new_product: "Recent product record · under 60 days",
  insufficient_stock_history: "Fewer than 14 observed in-stock days",
  unknown_age: "Product age unknown",
  dead: "Also counted as dead stock",
};

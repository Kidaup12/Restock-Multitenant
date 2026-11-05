/** Client-safe: names for recommendation actions. Kept apart from
 *  lib/data/recommendations (which imports Prisma) so the browser bundle never
 *  pulls in a database client. */
export type RecommendationAction = "stop_reorder" | "discount" | "bundle" | "clear";

export const ACTION_LABELS: Record<RecommendationAction, string> = {
  discount: "Discount it",
  bundle: "Bundle it",
  stop_reorder: "Skip the reorder",
  clear: "Return or clear",
};

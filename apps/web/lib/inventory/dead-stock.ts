/** Original app eligibility: silence only means dead stock after a fair chance to sell. */
export const NEW_PRODUCT_DAYS = 60;
export const MIN_OBSERVED_IN_STOCK_DAYS = 14;

export function isDeadStock(input: {
  currentStock: number;
  lastSaleAt: Date | null;
  firstSeenAt?: Date | null;
  inStockDays?: number;
  cutoff: Date;
  asOf: Date;
}): boolean {
  if (input.currentStock <= 0 || (input.lastSaleAt && input.lastSaleAt >= input.cutoff)) return false;
  if (input.inStockDays != null && input.inStockDays < MIN_OBSERVED_IN_STOCK_DAYS) return false;
  if (input.lastSaleAt) return true;
  return input.firstSeenAt != null &&
    input.asOf.getTime() - input.firstSeenAt.getTime() >= NEW_PRODUCT_DAYS * 86_400_000;
}

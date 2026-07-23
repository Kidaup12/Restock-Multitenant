/**
 * Overstock = stock that covers far more demand than needed (cash frozen on
 * the shelf). An item with NO sales is dead stock, not overstock — handled
 * elsewhere — so a zero run-rate never counts here.
 */
export function overstockExcess(input: {
  currentStock: number;
  dailyRate: number;
  costKes: number;
  thresholdDays: number;
}): { isOverstock: boolean; coverDays: number | null; excessUnits: number; excessValueKes: number } {
  const { currentStock, dailyRate, costKes, thresholdDays } = input;
  if (dailyRate <= 0) return { isOverstock: false, coverDays: null, excessUnits: 0, excessValueKes: 0 };
  const coverDays = currentStock / dailyRate;
  if (coverDays <= thresholdDays) return { isOverstock: false, coverDays, excessUnits: 0, excessValueKes: 0 };
  const excessUnits = currentStock - thresholdDays * dailyRate;
  return { isOverstock: true, coverDays, excessUnits, excessValueKes: excessUnits * costKes };
}

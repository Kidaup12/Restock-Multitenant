/** Shared UI/action contract. Keep runtime values outside client components. */
export const ABC_WINDOWS = [30, 60, 90] as const;
export type AbcWindow = (typeof ABC_WINDOWS)[number];
export type ForecastSettings = { baselineMethod: "mean" | "median"; abcWindowDays: AbcWindow; bigBuyerDamping: boolean };

export function parseForecastSettings(value: unknown): ForecastSettings | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.baselineMethod !== "mean" && row.baselineMethod !== "median") return null;
  if (!ABC_WINDOWS.includes(row.abcWindowDays as AbcWindow)) return null;
  if (typeof row.bigBuyerDamping !== "boolean") return null;
  return { baselineMethod: row.baselineMethod, abcWindowDays: row.abcWindowDays as AbcWindow, bigBuyerDamping: row.bigBuyerDamping };
}

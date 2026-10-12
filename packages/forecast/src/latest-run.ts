/** Prefer AI only when it covers at least half of the largest same-day run. */
export function pickBestRun(runs: { forecastRunId: string; count: number }[], aiRunIds: Set<string>): string | null {
  if (!runs.length) return null;
  const floor = Math.max(...runs.map(r => r.count)) / 2;
  return [...runs].sort((a, b) => {
    const aAi = Number(aiRunIds.has(a.forecastRunId) && a.count >= floor);
    const bAi = Number(aiRunIds.has(b.forecastRunId) && b.count >= floor);
    return bAi - aAi || b.count - a.count || a.forecastRunId.localeCompare(b.forecastRunId);
  })[0]!.forecastRunId;
}

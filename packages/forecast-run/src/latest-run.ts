import { prismaForTenant } from "@wezesha/db";
import { pickBestRun } from "@wezesha/forecast";

export async function latestForecastRun(tenantId: string): Promise<{ forecastRunId: string; runDate: Date } | null> {
  const db = prismaForTenant(tenantId);
  const latest = await db.prediction.findFirst({ orderBy: { runDate: "desc" }, select: { runDate: true } });
  if (!latest) return null;
  const [runs, aiRuns] = await Promise.all([
    db.prediction.groupBy({ by: ["forecastRunId"], where: { runDate: latest.runDate }, _count: { _all: true } }),
    db.prediction.groupBy({ by: ["forecastRunId"], where: { runDate: latest.runDate, regime: { in: ["sarima", "tsb", "cold_start"] } } }),
  ]);
  const forecastRunId = pickBestRun(runs.map(r => ({ forecastRunId: r.forecastRunId, count: r._count._all })), new Set(aiRuns.map(r => r.forecastRunId)));
  return forecastRunId ? { forecastRunId, runDate: latest.runDate } : null;
}

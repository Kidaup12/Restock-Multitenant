"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { saveForecastSettings } from "./actions";
import { ABC_WINDOWS, type ForecastSettings } from "./forecast-settings";
import { RunForecastButton } from "../../today/run-forecast-button";

export function ForecastSettingsForm({ initial, canManage }: { initial: ForecastSettings; canManage: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [savedValue, setSavedValue] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = value.baselineMethod !== savedValue.baselineMethod || value.abcWindowDays !== savedValue.abcWindowDays || value.bigBuyerDamping !== savedValue.bigBuyerDamping;

  return <Card>
    <CardHeader title="Forecast and bestseller ranking" subtitle="Choose how demand is estimated and how far back ABC counts sales revenue." />
    <CardContent>
      <form className="space-y-5" onSubmit={event => {
        event.preventDefault();
        setError(null);
        setMessage(null);
        start(async () => {
          try {
            const result = await saveForecastSettings(value);
            if (!result.ok) { setError(result.error); return; }
            setSavedValue(value);
            setMessage("Saved. Stock rates update now; ABC rankings and the buy list update on the next forecast run.");
            router.refresh();
          } catch {
            setError("Couldn't save these settings. Please try again.");
          }
        });
      }}>
        <fieldset disabled={!canManage || pending} className="space-y-2">
          <legend className="text-sm font-medium text-ink">Demand estimate</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="baseline-method" value="mean" checked={value.baselineMethod === "mean"} onChange={() => setValue(v => ({ ...v, baselineMethod: "mean" }))} />
            <span>Mean — recency-weighted average<span className="block text-xs text-ink-muted">Responds to changing sales, with unusually large sale days damped.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="baseline-method" value="median" checked={value.baselineMethod === "median"} onChange={() => setValue(v => ({ ...v, baselineMethod: "median" }))} />
            <span>Median — typical weekly demand<span className="block text-xs text-ink-muted">Less affected by unusual weeks. Thin or intermittent histories fall back to an adjusted average.</span></span>
          </label>
        </fieldset>
        <fieldset disabled={!canManage || pending} className="space-y-2">
          <legend className="text-sm font-medium text-ink">ABC revenue window</legend>
          <div className="flex flex-wrap gap-4">
            {ABC_WINDOWS.map(days => <label className="flex items-center gap-2 text-sm" key={days}>
              <input type="radio" name="abc-window" value={days} checked={value.abcWindowDays === days} onChange={() => setValue(v => ({ ...v, abcWindowDays: days }))} />
              {days} days
            </label>)}
          </div>
          <p className="text-xs text-ink-muted">Shorter windows reflect recent sellers; longer windows make rankings steadier. Changes apply on the next forecast run.</p>
        </fieldset>
        <fieldset disabled={!canManage || pending}>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={value.bigBuyerDamping} onChange={event => setValue(v => ({ ...v, bigBuyerDamping: event.target.checked }))} />
            <span>Reduce the forecast effect of possible bulk-sale days<span className="block text-xs text-ink-muted">Uses the original app’s bulk-day rule alongside existing spike protection. Actual sales and revenue stay unchanged. Unusual-sale flags appear whether this is on or off.</span></span>
          </label>
        </fieldset>
        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
        {message && <div className="space-y-2">
          <p role="status" className="text-sm text-positive">{message}</p>
          {canManage && <RunForecastButton />}
        </div>}
        {canManage && <Button type="submit" disabled={!dirty || pending} loading={pending}>Save forecast settings</Button>}
      </form>
    </CardContent>
  </Card>;
}

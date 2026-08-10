import { getDeclaredSignals, getSpikeSuggestions } from "@/lib/data/signals";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SignalsView } from "./signals-view";
import { SpikeSuggestions } from "./spike-suggestions";

/**
 * Loads what's been declared and leads with the effect in plain terms — the
 * owner should know exactly what changes in the ordering before filling a form.
 */
export async function SignalsSection({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const [data, spikes] = await Promise.all([
    getDeclaredSignals(tenantId),
    getSpikeSuggestions(tenantId),
  ]);

  return (
    <div className="space-y-6">
      {/* Ahead of the explainer: this is the one thing on the page that needs an
          answer rather than a read. */}
      <SpikeSuggestions suggestions={spikes} canManage={canManage} />

      <Card>
        <CardHeader title="Why this matters" />
        <CardContent className="space-y-3 pt-0 text-sm text-ink-secondary">
          <p>
            A giveaway or a discount doesn’t show what you normally sell — it shows what a good
            offer does. Leave those days in the average and every order for months afterwards is a
            little too big, and the extra sits on the shelf as dead stock.
          </p>
          <p>
            Tell us when you ran one and those days are left out when we work out your normal daily
            sales. Days you were shut work the same way in reverse: no sales because the doors were
            closed isn’t a slow day, so it’s left out too. Every other day still counts.
          </p>
          <p>
            A promotion that’s on now or still to come is treated differently — if you enter a
            discount, we expect it to lift sales and order for it.
          </p>
          <p className="rounded-md bg-surface-2 px-3 py-2 text-ink">
            Over the last {data.historyDays} days: {countLabel(data.promoDaysExcluded, "promotion day")}{" "}
            and {countLabel(data.closedDaysExcluded, "closed day")} left out of your normal sales
            rate. Changes here reach the buy list the next time the forecast runs.
          </p>
        </CardContent>
      </Card>

      <SignalsView
        promos={data.promos}
        closures={data.closures}
        locations={data.locations}
        catalogue={data.catalogue}
        canManage={canManage}
      />
    </div>
  );
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BulbIcon } from "@/components/icons";
import { evaluateLimits, limitCheck, type LimitDimension } from "@/lib/limits/evaluate";

/**
 * Plan-usage notice on Today — the warn half of warn-before-block, so a shop
 * meets its ceiling here rather than at a refused invite. Renders nothing while
 * every dimension has room, which is the normal case; it only appears on the
 * last place or once usage is past the cap.
 *
 * Same question the enforcement points ask (limitCheck), so the wording a
 * refusal shows is the wording that appeared here first.
 */

const DIMENSIONS: LimitDimension[] = ["products", "members", "orders30d"];

export async function TodayLimitNotice({ tenantId }: { tenantId: string }) {
  const state = await evaluateLimits(tenantId);
  const notices = DIMENSIONS.map((dimension) => ({
    dimension,
    check: limitCheck(state, dimension),
  })).filter((entry) => entry.check.message !== null);

  if (notices.length === 0) return null;

  const blocked = notices.some((entry) => !entry.check.allowed);

  return (
    <Card className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">Plan usage</span>
          <Badge tone={blocked ? "negative" : "warning"}>
            {blocked ? "Action needed" : "Heads up"}
          </Badge>
        </div>
        <ul className="flex flex-col gap-2 text-sm sm:max-w-md sm:text-right">
          {notices.map((entry) => (
            <li key={entry.dimension} className="flex items-start gap-2 sm:justify-end">
              <span className="mt-0.5 text-accent-ink [&_svg]:size-4">
                <BulbIcon />
              </span>
              <p className="text-ink-muted">{entry.check.message}</p>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { Stepper } from "@/components/ui/stepper";
// From @wezesha/forecast directly, not the lib/data/transfers re-export — that
// module pulls in prismaForTenant, and a client component reaching it drags
// the whole Prisma client into the browser bundle.
import { clampCoverDays, MIN_COVER_DAYS, MAX_COVER_DAYS } from "@wezesha/forecast";

/**
 * A typeable cover-days reading beside the preset pills. The pills only offer
 * 7/14/30 — the backend already accepts anything from 1 to 180
 * (`clampCoverDays`), so a shop that wants, say, 21 days had no way to ask for
 * it without this. Mirrors the Budget Planner's `Stepper[edit]` pattern
 * (`app/(shell)/plan/budget-planner.tsx`), but commits by navigating — this
 * screen's cover target lives in the URL, not in local state.
 */
export function CustomCoverInput({ coverDays, baseHref }: { coverDays: number; baseHref: string }) {
  const router = useRouter();
  const STEP = 1;

  function go(next: number) {
    const [path, search = ""] = baseHref.split("?");
    const params = new URLSearchParams(search);
    params.set("cover", String(clampCoverDays(next)));
    router.push(`${path}?${params.toString()}`);
  }

  return (
    <Stepper
      label="Custom"
      value={`${coverDays}d`}
      onDecrement={() => go(coverDays - STEP)}
      onIncrement={() => go(coverDays + STEP)}
      decrementLabel="One fewer day of cover"
      incrementLabel="One more day of cover"
      canDecrement={coverDays > MIN_COVER_DAYS}
      canIncrement={coverDays < MAX_COVER_DAYS}
      edit={{
        value: coverDays,
        min: MIN_COVER_DAYS,
        max: MAX_COVER_DAYS,
        unit: "days",
        ariaLabel: "Custom cover target in days",
        onCommit: go,
      }}
    />
  );
}

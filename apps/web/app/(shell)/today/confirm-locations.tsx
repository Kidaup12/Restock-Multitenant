"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BulbIcon } from "@/components/icons";
import type { PendingLocation } from "@/lib/capabilities/setup-depth";
import { setLocationRole } from "../settings/locations/actions";

/**
 * "Which of these is a shop, and which a store room?" — asked and answered in
 * the same place.
 *
 * This is the one setup question that changes the numbers rather than unlocking
 * a feature: a shopfront guessed as a warehouse hides its stock from the buy
 * list, and a warehouse guessed as a shopfront has the plan counting stock
 * nobody can sell. It used to be a sentence linking to Settings, which is a
 * detour off the screen the owner opens first — so it stayed unanswered on
 * every live workspace.
 *
 * Two buttons per location, the guess pre-selected. The rarer roles (en route,
 * ignore) stay on the Settings screen; putting four choices here would turn a
 * ten-second confirmation back into a decision.
 */
export function ConfirmLocations({ locations }: { locations: PendingLocation[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const remaining = locations.filter((l) => !done.has(l.id));
  if (remaining.length === 0) return null;

  function confirm(locationId: string, locationType: "branch" | "warehouse") {
    setError(null);
    startTransition(async () => {
      const result = await setLocationRole({ locationId, locationType });
      if (result.ok) {
        setDone((prev) => new Set(prev).add(locationId));
        // The role decides what counts as sellable, so every figure on this page
        // is now stale.
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-accent-ink [&_svg]:size-4">
          <BulbIcon />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-ink-muted">
            <span className="font-medium text-ink">
              {remaining.length === 1 ? "Check this location" : `Check these ${remaining.length} locations`}
            </span>{" "}
            — we guessed from the name. It decides which stock the buy list counts as sellable.
          </p>

          <ul className="space-y-1.5">
            {remaining.map((location) => (
              <li key={location.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">{location.name}</span>
                <Button
                  size="sm"
                  variant={location.guessedType === "warehouse" ? "ghost" : "primary"}
                  disabled={pending}
                  onClick={() => confirm(location.id, "branch")}
                >
                  Shop
                </Button>
                <Button
                  size="sm"
                  variant={location.guessedType === "warehouse" ? "primary" : "ghost"}
                  disabled={pending}
                  onClick={() => confirm(location.id, "warehouse")}
                >
                  Store room
                </Button>
              </li>
            ))}
          </ul>

          {error && (
            <p role="alert" className="text-sm text-negative">
              {error}
            </p>
          )}
          <Link href="/settings/locations" className="inline-block text-xs text-ink-muted hover:text-ink">
            More options
          </Link>
        </div>
      </div>
    </div>
  );
}

import { Card } from "@/components/ui/card";
import { setupChecklistFor } from "@/lib/capabilities/setup-checklist-read";
import { ConfirmLocations } from "./confirm-locations";
import { FinishSetupCard } from "./finish-setup-card";

/**
 * The two setup prompts that belong on the morning screen, in the order they
 * matter.
 *
 * `ConfirmLocations` comes first and is not part of the checklist: it unlocks
 * nothing, it is a correctness check only the shop can settle, and getting it
 * wrong changes the numbers rather than withholding a feature — a shopfront
 * guessed as a warehouse hides its stock from the buy list. It stays even once
 * the checklist is finished or dismissed.
 *
 * The capability ladder that used to render here has not gone away; it still
 * decides what the app unlocks (`lib/capabilities`). What changed is that the
 * screen now shows the shop its remaining work rather than its current rung,
 * which is the question someone opening Today is actually asking.
 */
export async function TodaySetupStrip({
  tenantId,
  displayName,
  canManageShop,
  canViewCosts,
}: {
  tenantId: string;
  displayName: string | null;
  canManageShop: boolean;
  /** The cost-coverage step is a cost fact; a money-blind member does not get it. */
  canViewCosts: boolean;
}) {
  const { steps, depth } = await setupChecklistFor(tenantId, {
    displayName,
    canManageShop,
    canViewCosts,
  });

  return (
    <>
      {depth.locationsToConfirm > 0 && (
        <Card className="px-5 py-4">
          <ConfirmLocations locations={depth.locationsPending} />
        </Card>
      )}
      <FinishSetupCard steps={steps} tenantId={tenantId} />
    </>
  );
}

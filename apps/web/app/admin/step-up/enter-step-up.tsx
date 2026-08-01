"use client";

import { useTransition } from "react";
import { StepUpPrompt } from "@/app/admin/step-up-prompt";
import { enterWorkspace } from "@/app/admin/actions";

/**
 * Confirms the password, then re-submits the entry that sent us here — so the
 * admin lands in the workspace they asked for rather than back at the fleet
 * list having to find it again.
 */
export function EnterWorkspaceStepUp({ tenantId }: { tenantId: string }) {
  const [, startTransition] = useTransition();

  return (
    <StepUpPrompt
      action="open this workspace"
      onConfirmed={() => {
        startTransition(async () => {
          const body = new FormData();
          body.set("tenantId", tenantId);
          // Redirects into the workspace on success; with the grant now held,
          // it cannot bounce back here.
          await enterWorkspace(body);
        });
      }}
    />
  );
}

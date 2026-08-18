"use client";

import { AlertIcon } from "@/components/icons";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Console error boundary — one failing operator screen stays one screen.
 *
 * `/admin` sits outside the app shell, so it never inherited the shell's
 * boundary: a single throw here escalated to the ROOT boundary, which renders
 * its own document and takes the console's own nav with it. Support looking at
 * a workspace mid-incident then loses the way back to the fleet.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title="Something went wrong" />
      <EmptyState
        icon={<AlertIcon />}
        title="This console page didn't load"
        description={
          error.digest
            ? `Try again — if it keeps happening, quote reference ${error.digest}.`
            : "Try again — if it keeps happening, reload the page or come back in a minute."
        }
        action={
          <div className="flex items-center gap-2">
            <Button onClick={reset}>Try again</Button>
            <ButtonLink href="/admin" variant="ghost">
              Back to the fleet
            </ButtonLink>
          </div>
        }
      />
    </div>
  );
}

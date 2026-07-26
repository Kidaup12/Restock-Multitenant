"use client";

import { AlertIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Shell error boundary — one page failing stays one page. Without it the only
 * boundary is the root one, which renders its own <html>: a single throw from a
 * page (an email provider rejecting a send, a stale query) would replace the
 * whole document, taking the nav and the workspace switcher with it and leaving
 * no way back. Here the shell survives, so the owner can switch screens or
 * retry. Server-side causes are already reported through instrumentation.ts.
 */
export default function ShellError({
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
        title="This page didn't load"
        description={
          error.digest
            ? `Try again — if it keeps happening, quote reference ${error.digest}.`
            : "Try again — if it keeps happening, reload the page or come back in a minute."
        }
        action={<Button onClick={reset}>Try again</Button>}
      />
    </div>
  );
}

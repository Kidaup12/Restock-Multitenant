import { ButtonLink } from "@/components/ui/button";
import { InboxIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Shell 404 — where notFound() lands for anything inside the app. Without it a
 * stale bookmark (a purchase order that was cancelled, a product that was
 * deleted) drops the owner on Next's bare 404 outside the shell, with no nav
 * and no way back.
 */
export default function ShellNotFound() {
  return (
    <div className="space-y-6">
      <PageHeader title="Not found" />
      <EmptyState
        icon={<InboxIcon />}
        title="That page isn't here"
        description="The link may be out of date, or the item was removed from this workspace."
        action={
          <ButtonLink href="/today">
            Back to Today
          </ButtonLink>
        }
      />
    </div>
  );
}

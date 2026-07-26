import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { WORKSPACE_NAME_MAX } from "@/lib/auth/workspaces";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewWorkspaceForm } from "./new-workspace-form";

export const metadata: Metadata = {
  title: "New workspace",
};

/* First run for a user with no invite: this is where a workspace comes from.
   Also the switcher's "Create workspace" destination for anyone adding a second. */
export default async function NewWorkspacePage() {
  await requireSession();

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader
        title="Create a workspace"
        description="One workspace per shop — its stock, suppliers, and orders stay separate from every other."
      />
      <Card>
        <CardContent className="p-6">
          <NewWorkspaceForm nameMaxLength={WORKSPACE_NAME_MAX} />
        </CardContent>
      </Card>
    </div>
  );
}

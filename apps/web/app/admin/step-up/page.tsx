import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/gate";
import { customerWorkspaceExists, getFleet } from "@/lib/admin/fleet";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EnterWorkspaceStepUp } from "./enter-step-up";

export const metadata: Metadata = { title: "Confirm your password" };

/**
 * The password prompt for entering a customer's workspace.
 *
 * Entering redirects rather than returning a result, so unlike the tier and
 * provisioning controls there is no form to keep alive and nowhere to show an
 * inline prompt. This page stands in for that: confirm, and it carries on into
 * the workspace that was being opened.
 */
export default async function StepUpPage({
  searchParams,
}: {
  searchParams: Promise<{ enter?: string }>;
}) {
  await requireAdmin();
  const { enter } = await searchParams;

  // Only ever reached with a workspace id this console put there. Anything else
  // is somebody typing in the address bar, and gets the same nothing they would
  // get for any other unknown console path.
  if (!enter || !(await customerWorkspaceExists(enter))) notFound();

  const workspace = (await getFleet()).find((row) => row.tenantId === enter);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Workspaces", href: "/admin" }, { label: "Confirm your password" }]}
        title="Confirm your password"
        description={
          workspace
            ? `Before opening ${workspace.name}`
            : "Before opening this workspace"
        }
      />
      <Card>
        <CardHeader
          title="This is someone's shop"
          subtitle="Opening it shows their costs, suppliers and sales. The visit is logged."
        />
        <CardContent>
          <EnterWorkspaceStepUp tenantId={enter} />
        </CardContent>
      </Card>
    </div>
  );
}

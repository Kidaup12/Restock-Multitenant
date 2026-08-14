import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRightIcon } from "@/components/icons";
import { activeMembership, requireSession } from "@/lib/auth";
import {
  navFor,
  TAB_BAR_HREFS,
} from "@/components/shell/nav-config";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "More",
};

export default async function MorePage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  /* Mobile overflow: every sidebar destination the bottom tab bar doesn't
   * already carry. Derived from the shared nav config, through the same filter
   * as the sidebar, so it can't offer what the rail withholds. */
  const links = navFor(membership).filter((d) => !TAB_BAR_HREFS.includes(d.href));

  return (
    <div className="space-y-6">
      <PageHeader title="More" />
      <Card>
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center gap-3 border-b border-edge px-5 py-4 transition-colors last:border-0 hover:bg-surface-2"
          >
            <div className="grid size-9 place-items-center rounded-md bg-surface-2 text-ink-secondary [&_svg]:size-4.5">
              {link.icon}
            </div>
            <span className="flex-1 text-sm font-medium text-ink">
              {link.label}
            </span>
            <ChevronRightIcon className="size-4 text-ink-faint" />
          </Link>
        ))}
      </Card>
    </div>
  );
}

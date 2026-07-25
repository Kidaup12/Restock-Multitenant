import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRightIcon } from "@/components/icons";
import {
  NAV_DESTINATIONS,
  TAB_BAR_HREFS,
} from "@/components/shell/nav-config";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "More",
};

/* Mobile overflow: every sidebar destination the bottom tab bar doesn't already
 * carry. Derived from the shared nav config so it can't fall out of sync. */
const links = NAV_DESTINATIONS.filter((d) => !TAB_BAR_HREFS.includes(d.href));

export default function MorePage() {
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

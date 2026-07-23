import type { Metadata } from "next";
import Link from "next/link";
import {
  BulbIcon,
  ChevronRightIcon,
  ClipboardIcon,
  GearIcon,
} from "@/components/icons";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "More",
};

/* Mobile overflow for sidebar destinations that don't fit the tab bar. */
const links = [
  { href: "/orders", label: "Orders", icon: <ClipboardIcon /> },
  { href: "/insights", label: "Insights", icon: <BulbIcon /> },
  { href: "/settings", label: "Settings", icon: <GearIcon /> },
];

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

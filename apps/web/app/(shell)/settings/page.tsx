import type { Metadata } from "next";
import Link from "next/link";
import {
  BoxIcon,
  ChevronRightIcon,
  GearIcon,
  LayersIcon,
  UsersIcon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Settings",
};

const sections = [
  {
    href: "/settings/locations",
    icon: <BoxIcon />,
    title: "Locations",
    description: "What each location does for your stock math — sells, holds, ignores.",
  },
  {
    href: "/settings/team",
    icon: <UsersIcon />,
    title: "Team",
    description: "Invite teammates, set roles, and remove access.",
  },
  {
    href: "/settings/connections",
    icon: <LayersIcon />,
    title: "Connections",
    description: "Shopify, QuickBooks, and the POS feed — connect and check sync health.",
  },
];

const upcoming = [
  {
    icon: <GearIcon />,
    title: "Workspace",
    description: "Name, currency, and forecast preferences.",
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Workspace, team, and integrations"
      />
      <Card>
        {sections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="flex items-center gap-3 border-b border-edge px-5 py-4 transition-colors last:border-0 hover:bg-surface-2"
          >
            <div className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-ink-secondary [&_svg]:size-4.5">
              {section.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">{section.title}</div>
              <div className="truncate text-xs text-ink-muted">
                {section.description}
              </div>
            </div>
            <ChevronRightIcon className="size-4 shrink-0 text-ink-faint" />
          </Link>
        ))}
        {upcoming.map((section) => (
          <div
            key={section.title}
            className="flex items-center gap-3 border-t border-edge px-5 py-4 opacity-70"
          >
            <div className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-ink-muted [&_svg]:size-4.5">
              {section.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink-secondary">
                {section.title}
              </div>
              <div className="truncate text-xs text-ink-muted">
                {section.description}
              </div>
            </div>
            <Badge>Coming soon</Badge>
          </div>
        ))}
      </Card>
    </div>
  );
}

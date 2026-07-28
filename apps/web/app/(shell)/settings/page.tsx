import type { Metadata } from "next";
import Link from "next/link";
import {
  BoxIcon,
  CalendarIcon,
  ChevronRightIcon,
  GearIcon,
  LayersIcon,
  UsersIcon,
} from "@/components/icons";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Settings",
};

const sections = [
  {
    href: "/settings/workspace",
    icon: <GearIcon />,
    title: "Workspace",
    description: "Name, trading day, alert email, dead stock, and how you buy.",
  },
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
    description: "Connect your Shopify store and check how recently it synced.",
  },
  {
    href: "/settings/signals",
    icon: <CalendarIcon />,
    title: "Promotions & closures",
    description: "Days that weren't normal trading — so a giveaway doesn't inflate every order after it.",
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
      </Card>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export type NavItemProps = {
  href: string;
  label: string;
  icon: React.ReactNode;
  /* rail = sidebar entry, tab = bottom tab bar entry */
  layout?: "rail" | "tab";
  collapsed?: boolean;
};

export function NavItem({
  href,
  label,
  icon,
  layout = "rail",
  collapsed = false,
}: NavItemProps) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  if (layout === "tab") {
    return (
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors [&_svg]:size-5",
          active ? "text-accent-ink" : "text-ink-muted hover:text-ink",
        )}
      >
        {icon}
        <span>{label}</span>
      </Link>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors [&_svg]:size-5 [&_svg]:shrink-0",
        collapsed && "justify-center px-0",
        active
          ? "bg-accent text-on-accent shadow-glow"
          : "text-ink-secondary hover:bg-surface-2 hover:text-ink",
      )}
    >
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

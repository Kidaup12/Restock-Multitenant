"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { useRouteLoading } from "@/components/shell/route-loading";

export type NavItemProps = {
  href: string;
  label: string;
  icon: React.ReactNode;
  /* rail = sidebar entry, tab = bottom tab bar entry */
  layout?: "rail" | "tab";
  collapsed?: boolean;
  /* data-tour key so the interactive tour can spotlight this entry. */
  tourKey?: string;
};

/**
 * Spinner shown on a nav item while its route opens. It stays up through BOTH
 * phases so it clears with the page skeleton, not at route-commit:
 *  - navigation pending (click → route commit): the Link's own pending state;
 *  - content loading (skeleton on screen): the shared route-loading signal on
 *    the now-active item.
 */
function NavPending({ active, className }: { active: boolean; className?: string }) {
  const { pending } = useLinkStatus();
  const loading = useRouteLoading();
  if (!pending && !(active && loading)) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70",
        className,
      )}
    />
  );
}

export function NavItem({
  href,
  label,
  icon,
  layout = "rail",
  collapsed = false,
  tourKey,
}: NavItemProps) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  if (layout === "tab") {
    return (
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        data-tour={tourKey}
        className={cn(
          "relative flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors [&_svg]:size-5",
          active ? "text-accent-ink" : "text-ink-muted hover:text-ink",
        )}
      >
        {icon}
        <span>{label}</span>
        <NavPending active={active} className="absolute right-2 top-1.5" />
      </Link>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      data-tour={tourKey}
      className={cn(
        "relative flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors [&_svg]:size-5 [&_svg]:shrink-0",
        collapsed && "justify-center px-0",
        active
          ? "bg-accent text-on-accent shadow-glow"
          : "text-ink-secondary hover:bg-surface-2 hover:text-ink",
      )}
    >
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
      <NavPending active={active} className={collapsed ? "absolute right-1 top-1" : "ml-auto"} />
    </Link>
  );
}

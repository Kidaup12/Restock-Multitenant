"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/** Spinner shown on a nav item while its route is loading (App Router pending
 *  state of the enclosing Link). */
function NavPending({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
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
        <NavPending className="absolute right-2 top-1.5" />
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
      <NavPending className={collapsed ? "absolute right-1 top-1" : "ml-auto"} />
    </Link>
  );
}

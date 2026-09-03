"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { useRouteLoading } from "@/components/shell/route-loading";

export type NavItemProps = {
  href: string;
  label: string;
  icon: React.ReactNode;
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

/**
 * One rail entry.
 *
 * The active entry is a tinted band with ink text and an accent-tinted icon —
 * not a solid accent fill. A filled row shouts as loudly as a primary button,
 * and with eleven of them the rail was the noisiest thing on screen; the tint
 * marks where you are without competing with the page.
 */
export function NavItem({ href, label, icon, tourKey }: NavItemProps) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      data-tour={tourKey}
      className={cn(
        // 16px icons, not 18. The label is 14px and the row is 36px tall in both
        // builds; an icon larger than its label is what made the rail read as
        // oversized beside the reference at the same measurements.
        "relative flex items-center gap-2.5 rounded-sm px-3 py-2 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
        "outline-none focus-visible:ring-2 focus-visible:ring-accent-300",
        active
          ? "bg-surface-2 font-medium text-ink"
          : "text-ink-secondary hover:bg-surface-2/60 hover:text-ink",
      )}
    >
      <span className={cn("shrink-0", active ? "text-accent-ink" : "text-ink-muted")}>{icon}</span>
      <span className="truncate">{label}</span>
      <NavPending active={active} className="ml-auto" />
    </Link>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { requireAdmin } from "@/lib/admin/gate";
import { AdminSignOutButton } from "./sign-out-button";

export const metadata: Metadata = {
  title: {
    default: "Admin",
    template: "%s · Admin · Wezesha Restock",
  },
};

/**
 * Operator console chrome — deliberately outside (shell): no workspace
 * switcher, no tenant nav, its own gate. Every page below re-runs
 * requireAdmin() itself; this layout's check just keeps the chrome from
 * rendering around a 404.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdmin();

  return (
    <div className="min-h-dvh bg-page">
      <header className="sticky top-0 z-10 border-b border-edge bg-surface/90 backdrop-blur">
        {/* Wraps below ~440px. Five non-shrinking items in one nowrap row gave
            the console a hard minimum wider than a phone, so every /admin page
            scrolled sideways and the sticky bar detached from the content. */}
        <div className="mx-auto flex min-h-14 max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 sm:h-14 sm:flex-nowrap sm:py-0 sm:px-6">
          <Link href="/admin" className="flex items-baseline gap-2">
            <span className="text-sm font-bold tracking-tight text-ink-strong">
              Wezesha
            </span>
            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-semibold tracking-wider text-accent-ink uppercase">
              Admin
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-sm font-medium text-ink-secondary">
            <Link href="/admin" className="transition-colors hover:text-ink">
              Fleet
            </Link>
            <Link href="/admin/audit" className="transition-colors hover:text-ink">
              Audit log
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {/* The console has no sidebar and no workspace switcher by design,
                which left no way back to one's own shop except editing the URL. */}
            <Link
              href="/today"
              className="text-sm font-medium text-ink-secondary transition-colors hover:text-ink"
            >
              Back to app
            </Link>
            <span className="hidden max-w-[16rem] truncate text-xs text-ink-muted sm:block">
              {admin.email}
            </span>
            {/* The console has no profile menu, so this was the one shell in the
                app an operator could not sign out of — on a shared machine, the
                way out was to walk back into a customer's workspace and use its
                menu instead. */}
            <AdminSignOutButton />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}

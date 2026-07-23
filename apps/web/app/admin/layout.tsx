import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { requireAdmin } from "@/lib/admin/gate";

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
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/admin" className="flex items-baseline gap-2">
            <span className="font-display text-sm font-bold tracking-tight text-ink-strong">
              Wezesha
            </span>
            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-accent-ink uppercase">
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
            <span className="hidden text-xs text-ink-muted sm:block">{admin.email}</span>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}

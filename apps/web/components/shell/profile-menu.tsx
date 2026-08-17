"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clearAdminCookies } from "@/app/admin/sign-out-actions";
import { cn } from "@/lib/cn";
import { authClient } from "@/lib/auth-client";
import { useInstallPrompt } from "@/lib/use-install-prompt";
import { useTour } from "@/components/tour/tour-provider";
import {
  DownloadIcon,
  GearIcon,
  LayersIcon,
  LogOutIcon,
  PlayCircleIcon,
  UserIcon,
} from "@/components/icons";

export type ProfileMenuProps = {
  name: string;
  email: string;
  /* "Owner" / "Admin" / "Member", or "No workspace". */
  roleLabel: string;
  /* Caller is on the ADMIN_EMAILS allow-list (resolved server-side by
     lib/admin/gate). False for everyone else, and the operator entry is then
     never rendered — the console stays unadvertised. */
  isPlatformAdmin: boolean;
};

const itemClass = cn(
  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-ink-secondary transition-colors",
  "outline-none hover:bg-surface-2 hover:text-ink focus-visible:bg-surface-2 focus-visible:text-ink",
  "[&_svg]:size-4.5 [&_svg]:shrink-0",
);

export function ProfileMenu({
  name,
  email,
  roleLabel,
  isPlatformAdmin,
}: ProfileMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { canInstall, promptInstall } = useInstallPrompt();
  const tour = useTour();

  const initial = (name.trim() || email).charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus();
    }
  }, [open]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? items[(index + 1) % items.length]
        : items[(index - 1 + items.length) % items.length];
    next?.focus();
  }

  function navigate(href: string) {
    setOpen(false);
    router.push(href);
  }

  async function signOut() {
    setSigningOut(true);
    // Before Better Auth drops the session: it owns sign-out and has never
    // heard of the console's cookies, so nothing else would clear them.
    await clearAdminCookies().catch(() => {});
    await authClient.signOut();
    router.push("/login");
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tour="profile-menu"
        className={cn(
          "grid size-9 place-items-center rounded-full bg-accent text-sm font-bold text-on-accent transition-shadow",
          "outline-accent hover:shadow-glow focus-visible:outline-2 focus-visible:outline-offset-2",
        )}
      >
        {initial}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-30 mt-2 w-64 rounded-lg border border-edge bg-surface p-1.5 shadow-pop"
        >
          <div className="px-3 pt-2 pb-3">
            <div className="truncate text-sm font-semibold text-ink">
              {name}
            </div>
            <div className="truncate text-xs text-ink-muted">{email}</div>
            <div className="mt-0.5 text-xs text-ink-faint">{roleLabel}</div>
          </div>
          <div className="mx-1.5 border-t border-edge" />

          <div className="py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => navigate("/profile")}
              className={itemClass}
            >
              <UserIcon />
              Profile
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => navigate("/settings")}
              className={itemClass}
            >
              <GearIcon />
              Settings
            </button>
            {tour.available && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  tour.start();
                }}
                className={itemClass}
              >
                <PlayCircleIcon />
                Start interactive tour
              </button>
            )}
          </div>

          {/* Cross-tenant operator console. It belongs to the person, not the
              workspace, so it sits with the other account entries rather than
              in the workspace nav. */}
          {isPlatformAdmin && (
            <>
              <div className="mx-1.5 border-t border-edge" />
              <div className="py-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => navigate("/admin")}
                  className={itemClass}
                >
                  <LayersIcon />
                  Operator console
                </button>
              </div>
            </>
          )}

          {canInstall && (
            <>
              <div className="mx-1.5 border-t border-edge" />
              <div className="py-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    void promptInstall();
                  }}
                  className={itemClass}
                >
                  <DownloadIcon />
                  Install app
                </button>
              </div>
            </>
          )}

          <div className="mx-1.5 border-t border-edge" />
          <div className="py-1">
            <button
              type="button"
              role="menuitem"
              disabled={signingOut}
              onClick={() => void signOut()}
              className={cn(
                itemClass,
                "text-negative hover:bg-negative-soft hover:text-negative focus-visible:bg-negative-soft focus-visible:text-negative",
                signingOut && "pointer-events-none opacity-60",
              )}
            >
              <LogOutIcon />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

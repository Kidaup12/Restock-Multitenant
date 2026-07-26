"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { switchWorkspace } from "@/lib/auth-actions";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  PlusIcon,
} from "@/components/icons";

export type WorkspaceOption = {
  id: string;
  name: string;
  roleLabel: string;
};

export type WorkspaceSwitcherProps = {
  workspaces: WorkspaceOption[];
  activeId: string | null;
  /* rail = sidebar bottom (menu drops up), header = mobile top bar (drops down). */
  layout?: "rail" | "header";
  collapsed?: boolean;
};

function WorkspaceInitial({ name }: { name: string }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent-soft font-display text-xs font-bold text-accent-ink">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function WorkspaceSwitcher({
  workspaces,
  activeId,
  layout = "rail",
  collapsed = false,
}: WorkspaceSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const active =
    workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null;

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
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
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
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ) ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? items[(current + 1) % items.length]
        : items[(current - 1 + items.length) % items.length];
    next?.focus();
  }

  function select(id: string) {
    if (id === active?.id) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      const { ok } = await switchWorkspace(id);
      setOpen(false);
      if (ok) router.refresh();
    });
  }

  if (!active) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-tour="workspace-switcher"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Workspace: ${active.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md text-left transition-colors",
          "outline-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2",
          layout === "rail" && (collapsed ? "justify-center px-0 py-1.5" : "px-2 py-1.5"),
          layout === "header" && "min-w-0 py-1 pr-1.5",
        )}
      >
        <WorkspaceInitial name={active.name} />
        {!(layout === "rail" && collapsed) && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-semibold text-ink">
                {active.name}
              </span>
              <span className="block truncate text-xs text-ink-muted">
                {active.roleLabel}
              </span>
            </span>
            <ChevronsUpDownIcon className="size-4 shrink-0 text-ink-faint" />
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Workspaces"
          onKeyDown={onMenuKeyDown}
          className={cn(
            "absolute left-0 z-30 w-60 rounded-lg border border-edge bg-surface p-1.5 shadow-pop",
            layout === "rail" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          <div className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wider text-ink-muted uppercase">
            Workspaces
          </div>
          <div className="py-1">
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
                disabled={pending}
                onClick={() => select(workspace.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                  "outline-none hover:bg-surface-2 focus-visible:bg-surface-2",
                  pending && "pointer-events-none opacity-60",
                )}
              >
                <WorkspaceInitial name={workspace.name} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium text-ink">
                    {workspace.name}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">
                    {workspace.roleLabel}
                  </span>
                </span>
                {workspace.id === active.id && (
                  <CheckIcon className="size-4 shrink-0 text-accent-ink" />
                )}
              </button>
            ))}
          </div>
          <div className="mx-1.5 border-t border-edge" />
          <div className="py-1">
            <Link
              href="/workspaces/new"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium text-ink",
                "outline-none hover:bg-surface-2 focus-visible:bg-surface-2",
              )}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md border border-dashed border-edge-strong text-ink-muted">
                <PlusIcon className="size-3.5" />
              </span>
              Create workspace
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { cn } from "@/lib/cn";
import { MoonIcon, SunIcon } from "@/components/icons";

const STORAGE_KEY = "wezesha-theme";

/*
 * The active icon is chosen by CSS (dark: variant), so no client state is
 * needed and there is nothing to mismatch on hydration.
 */
export function ThemeToggle({ className }: { className?: string }) {
  function toggle() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode; the choice just won't persist.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className={cn(
        "grid size-9 place-items-center rounded-md border border-edge bg-surface text-ink-secondary transition-colors",
        "outline-accent hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2",
        className,
      )}
    >
      <SunIcon className="hidden size-4.5 dark:block" />
      <MoonIcon className="size-4.5 dark:hidden" />
    </button>
  );
}

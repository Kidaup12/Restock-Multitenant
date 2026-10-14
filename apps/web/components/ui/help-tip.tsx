"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A visible "?" that explains the control beside it.
 *
 * `InfoDot` (term.tsx) leans on the native `title` tooltip: it takes a second to
 * appear, never appears on a phone, and most people never find it. This one
 * opens on hover, on keyboard focus and on tap, closes on Escape or a click
 * elsewhere, and renders the explanation as a styled card a reader can
 * actually read.
 */
export function HelpTip({
  children,
  label = "What does this mean?",
  align = "start",
  className,
}: {
  /** The explanation. Plain sentences; a short list is fine. */
  children: React.ReactNode;
  /** Accessible name for the button. */
  label?: string;
  /** Which edge of the "?" the card lines up with. */
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Tapped open stays open until dismissed; hovered open closes on leave.
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={ref}
      className={cn("relative inline-flex align-middle", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => {
          setPinned((p) => !p || !open);
          setOpen((o) => !(o && pinned));
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          if (!pinned) setOpen(false);
        }}
        className="grid size-4 place-items-center rounded-full border border-edge-strong bg-surface text-[10px] leading-none font-semibold text-ink-muted transition-colors hover:border-accent-500 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "absolute top-full z-30 mt-2 block w-72 rounded-md border border-edge bg-surface p-3 text-left text-xs leading-relaxed font-normal text-ink-secondary normal-case shadow-pop",
            align === "start" ? "left-0" : "right-0"
          )}
        >
          {children}
        </span>
      )}
    </span>
  );
}

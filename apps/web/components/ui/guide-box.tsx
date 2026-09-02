"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { dismissGuide, isGuideDismissed } from "@/lib/guides";

/**
 * What this page is for, in the shop's language, said once.
 *
 * The numbers on these screens are the product's whole argument — run rate,
 * days of cover, cash tied up — and none of them explain themselves. A
 * non-technical owner needs the sentence once, not on every visit, so this
 * remembers being dismissed and one "Got it" quiets the set.
 *
 * Renders nothing on the server. The alternative is a box that appears on
 * every load and vanishes a beat later for everyone who has already dismissed
 * it, which is worse than never showing it.
 */
export function GuideBox({
  id,
  scope,
  title,
  independent = false,
  className,
  children,
}: {
  /** Stable per page — changing it re-opens the box for everyone. */
  id: string;
  /** The workspace, so the same person can be new to a second shop. */
  scope: string;
  title: string;
  /** Opt out of the shared "quiet them all" flag. */
  independent?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      setShow(!isGuideDismissed(localStorage, scope, id, independent));
    } catch {
      // Site data blocked. Showing it is the safer failure: an explainer that
      // appears once too often beats a page that throws.
      setShow(true);
    }
  }, [scope, id, independent]);

  if (!show) return null;

  function dismiss() {
    try {
      dismissGuide(localStorage, scope, id, independent);
    } catch {
      /* nothing to remember it with; closing for this visit is still right */
    }
    setShow(false);
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-accent-200 bg-accent-soft px-4 py-3",
        className,
      )}
    >
      <span
        aria-hidden
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent-100 text-2xs font-bold text-accent-ink"
      >
        i
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        <div className="mt-1 text-xs leading-relaxed text-ink-secondary">{children}</div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded-md border border-edge bg-surface px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink"
      >
        Got it
      </button>
    </div>
  );
}

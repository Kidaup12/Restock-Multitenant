"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The app's own "are you sure".
 *
 * `window.confirm` was doing this job, and it is the wrong tool three ways: it
 * renders as browser chrome, so it arrives unstyled, in the wrong theme, and
 * captioned with the deployment's hostname rather than the shop's own product;
 * it cannot say which action is destructive; and it blocks the renderer, so
 * nothing automated can exercise the action behind it — every delete path in
 * this app was unreachable by any test that drives a browser.
 *
 * The hook keeps the call sites' shape. They were written as
 * `if (!confirm(msg)) return;` inside an event handler, and they stay that way
 * with an await, so the guard is still the first thing you read in the handler
 * rather than a state machine spread across the component.
 */

export type ConfirmOptions = {
  /** What is about to happen, and what it costs. Not a question — the buttons
   *  ask the question. */
  title: string;
  /** The consequence, in the shop's terms. Optional only for the reversible. */
  body?: ReactNode;
  /** The verb that does it: "Remove supplier", "Cancel order". Never "OK" —
   *  a button that repeats the question tells the reader nothing. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive actions get the danger button. Default true, because anything
   *  worth confirming usually is. */
  danger?: boolean;
};

export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  // Held in a ref, not state: resolving is not a render, and putting the
  // resolver in state would make every keystroke elsewhere a chance to lose it.
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    setOpen(options);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    setOpen(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const dialog = open ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 grid place-items-center p-4"
    >
      {/* Clicking away cancels — the safe outcome is the easy one to reach. */}
      <button
        type="button"
        aria-label={open.cancelLabel ?? "Cancel"}
        onClick={() => settle(false)}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-[1px]"
      />
      <div className="relative w-full max-w-md rounded-lg border border-edge bg-surface p-5 shadow-pop">
        <h2 id="confirm-title" className="text-base font-semibold text-ink">
          {open.title}
        </h2>
        {open.body && <div className="mt-2 text-sm text-ink-muted">{open.body}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => settle(false)}>
            {open.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={open.danger === false ? "primary" : "danger"}
            size="sm"
            autoFocus
            onClick={() => settle(true)}
          >
            {open.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}

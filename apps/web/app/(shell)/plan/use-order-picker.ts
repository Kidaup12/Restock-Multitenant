"use client";

import { useState, useTransition } from "react";
import { addToOrder } from "./actions";

/**
 * Turning a set of ticked plan rows into pending order lines.
 *
 * Extracted because budget mode needed the same thing the checklist already
 * had. Writing it twice would have produced two answers to "what does ticking a
 * row and pressing the button do" — and this codebase's most repeated defect is
 * exactly that: two expressions that must agree, written separately, drifting
 * until one of them is wrong. Both screens now share one selection, one call and
 * one set of words for the outcome.
 *
 * Keyed on predictionId, which is what the order action accepts: a row is a
 * recommendation from a particular run, not a product in the abstract.
 */

export type PickerNotice = { kind: "ok" | "err"; text: string } | null;

export function useOrderPicker() {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<PickerNotice>(null);
  const [pending, startTransition] = useTransition();

  function toggle(predictionId: string): void {
    setPicked((set) => {
      const next = new Set(set);
      if (next.has(predictionId)) next.delete(predictionId);
      else next.add(predictionId);
      return next;
    });
  }

  /** Replace the whole selection — the select-all / clear controls. */
  function replace(ids: Iterable<string>): void {
    setPicked(new Set(ids));
  }

  function submit(): void {
    const predictionIds = [...picked];
    startTransition(async () => {
      const result = await addToOrder({ predictionIds });
      if (!result.ok) {
        setNotice({ kind: "err", text: result.error });
        return;
      }
      const { created, updated } = result.data;
      const lines = created + updated;
      setNotice({
        kind: "ok",
        text: `${lines} ${lines === 1 ? "line" : "lines"} added to Orders as pending.`,
      });
      setPicked(new Set());
    });
  }

  return { picked, toggle, replace, submit, notice, setNotice, pending };
}

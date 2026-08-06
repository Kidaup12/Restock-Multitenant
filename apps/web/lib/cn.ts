import { twMerge } from "tailwind-merge";

/**
 * Join class names, letting a caller's class REPLACE a component's default
 * rather than sit beside it.
 *
 * This used to be `parts.filter(Boolean).join(" ")`, so a conflicting pair —
 * `min-w-[560px]` from a component and `min-w-0` from its caller — both reached
 * the DOM, and which one applied came down to the order Tailwind happened to
 * emit them in the stylesheet. An override could read correctly in the source,
 * do nothing on screen, and give no clue why. A `min-w-0` passed to `Table` lost
 * exactly that way, defeating a fix already in the tree.
 *
 * With the merge the LAST conflicting utility wins — what every caller writing
 * `cn(base, override)` already assumes.
 */
export function cn(...parts: Array<string | false | null | undefined>) {
  return twMerge(parts.filter(Boolean).join(" "));
}

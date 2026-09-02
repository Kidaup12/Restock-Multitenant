/**
 * Which page explainers a reader has already dismissed.
 *
 * Pure, and separated from the component on purpose: the interesting behaviour
 * is not the box, it is WHEN it stops appearing. Explainers that each demand
 * their own dismissal turn a first session into a chore — six pages, six boxes,
 * six clicks — so dismissing any one of them quiets the rest. Someone who has
 * understood one page has understood the pattern.
 *
 * Keyed by workspace, because the same person can be new to a second shop.
 *
 * Every read and write is wrapped by the caller: a browser with site data
 * blocked throws on access rather than returning null, and an explainer is not
 * worth breaking a page over.
 */

const PREFIX = "wz.guide";

/** One guide's own key. */
export function guideKey(scope: string, id: string): string {
  return `${PREFIX}.${scope}.${id}`;
}

/** The workspace-wide "I know this app" flag that quiets the whole set. */
export function seenKey(scope: string): string {
  return `${PREFIX}.${scope}.seen`;
}

export type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem"> & {
  readonly length?: number;
  key?(index: number): string | null;
};

/**
 * Whether this explainer should stay hidden.
 *
 * `independent` opts a guide out of the shared flag — for a page whose
 * explanation is worth reading even by someone who has dismissed the others.
 */
export function isGuideDismissed(
  storage: Storage,
  scope: string,
  id: string,
  independent = false,
): boolean {
  if (storage.getItem(guideKey(scope, id)) === "1") return true;
  return !independent && storage.getItem(seenKey(scope)) === "1";
}

export function dismissGuide(
  storage: Storage,
  scope: string,
  id: string,
  independent = false,
): void {
  storage.setItem(guideKey(scope, id), "1");
  // An independent guide is dismissed alone: it never claimed to stand for the
  // others, so it must not answer for them either.
  if (!independent) storage.setItem(seenKey(scope), "1");
}

/** Bring every explainer in this workspace back. */
export function resetGuides(storage: Storage, scope: string): void {
  storage.removeItem(seenKey(scope));
  const keys: string[] = [];
  const length = storage.length ?? 0;
  for (let i = 0; i < length; i++) {
    const k = storage.key?.(i);
    if (k && k.startsWith(`${PREFIX}.${scope}.`)) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
}

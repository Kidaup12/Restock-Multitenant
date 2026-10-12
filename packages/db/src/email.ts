/**
 * The one shape check for an address a platform-admin grant is given.
 *
 * Shared because the two paths into the platform-admin table disagreed. The
 * bootstrap script validated the address; the console did not, and went straight
 * to a lookup — so a mistyped address came back as "No account with that
 * address. They need to sign in once before you can grant access." A real
 * account, a real person, a missing ".com", and an operator sent to chase an
 * onboarding problem that did not exist.
 *
 * Deliberately a shape check and nothing more. Whether an address receives mail
 * is a question only sending to it can answer, and a stricter pattern would
 * reject valid addresses to no purpose here — the lookup is the real gate. This
 * exists so the lookup's "not found" can only ever mean what it says.
 */
export function looksLikeEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value.trim());
}

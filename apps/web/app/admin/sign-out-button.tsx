"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { clearAdminCookies } from "./sign-out-actions";

/**
 * Sign out of the operator console.
 *
 * The console is deliberately outside the app shell — no sidebar, no workspace
 * switcher, no profile menu — which left an operator on a shared machine with no
 * way out except walking back into a customer's workspace to find the app's own
 * menu, or editing the URL.
 *
 * The order matters and is the same one the app's profile menu uses: clear the
 * console's own cookies FIRST, because Better Auth owns sign-out and has never
 * heard of them. Signing out is also a way out of a customer's workspace, so
 * `clearAdminCookies` is what closes the visit in the ledger.
 */
export function AdminSignOutButton() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await clearAdminCookies().catch(() => {});
    await authClient.signOut();
    router.push("/login");
  }

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={signingOut}
      className="text-sm font-medium text-ink-secondary transition-colors hover:text-ink disabled:opacity-60"
    >
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  );
}

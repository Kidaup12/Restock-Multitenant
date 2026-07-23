import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

/** Browser-side auth API (same-origin /api/auth). */
export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
});

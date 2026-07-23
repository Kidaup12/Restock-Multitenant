import { Suspense } from "react";
import type { Metadata } from "next";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = {
  title: "Reset password",
};

export default function ResetPasswordPage() {
  // Suspense: the form reads the reset token from the query string.
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

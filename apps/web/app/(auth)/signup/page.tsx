import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, safeInternalPath } from "@/lib/auth";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = {
  title: "Create account",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  // Invite links arrive with ?redirect=/invite/{token} so a fresh account
  // lands back on the acceptance page.
  const redirectTo = safeInternalPath((await searchParams).redirect);
  if (await getSession()) redirect(redirectTo ?? "/today");
  return <SignupForm redirectTo={redirectTo} />;
}

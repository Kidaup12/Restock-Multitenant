import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, safeInternalPath } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const redirectTo = safeInternalPath((await searchParams).redirect);
  if (await getSession()) redirect(redirectTo ?? "/today");
  return <LoginForm redirectTo={redirectTo} />;
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CodeForm } from "./code-form";

export const metadata: Metadata = {
  title: "Sign in with a code",
};

export default async function CodeLoginPage() {
  if (await getSession()) redirect("/today");
  return <CodeForm />;
}

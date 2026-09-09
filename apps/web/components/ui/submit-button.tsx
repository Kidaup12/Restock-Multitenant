"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * A submit button that knows its own form is in flight.
 *
 * `useTransition` is the pattern everywhere a client component calls a server
 * action, and it covers most of the app. It cannot cover a **server** component
 * that renders `<form action={someServerAction}>` — there is no client state to
 * hang a spinner on, so those buttons had no pending feedback at all. Three did:
 * entering a workspace, leaving it, and entering from the fleet table. Each is
 * a real round trip that ends in a redirect, so the operator pressed a button,
 * saw nothing change, and pressed it again.
 *
 * `useFormStatus` reads the status of the form this button sits inside, which is
 * why it must be its own client component: the hook reports on the nearest
 * enclosing form, and a component that rendered the form itself would always
 * read idle.
 */
export function SubmitButton({
  children,
  ...rest
}: Omit<React.ComponentProps<typeof Button>, "type" | "loading">) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...rest}>
      {children}
    </Button>
  );
}

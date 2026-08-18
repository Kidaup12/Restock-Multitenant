"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { EyeIcon, EyeOffIcon } from "@/components/icons";
import { Input, type InputProps } from "@/components/ui/input";

type PasswordInputProps = Omit<InputProps, "type">;

export function PasswordInput({ className, ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        className={cn("pr-11", className)}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        /* Deliberately not "Show password": the field itself is labelled
           Password, and a second control carrying that word means asking for
           "Password" by voice or screen reader is ambiguous — it can land on
           the toggle instead of the input. Naming the action rather than the
           field keeps both reachable. */
        aria-label={visible ? "Hide characters" : "Show characters"}
        aria-pressed={visible}
        className={cn(
          "absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-md text-ink-muted transition-colors",
          "outline-accent hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2",
        )}
      >
        {visible ? (
          <EyeOffIcon className="size-4.5" />
        ) : (
          <EyeIcon className="size-4.5" />
        )}
      </button>
    </div>
  );
}

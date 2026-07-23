"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { EyeIcon, EyeOffIcon } from "@/components/icons";
import { Input } from "@/components/ui/input";

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
>;

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
        aria-label={visible ? "Hide password" : "Show password"}
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

import { ThemeToggle } from "@/components/ui/theme-toggle";

/* Standalone centered frame — invite links are opened signed-out too. */
export default function InviteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-100">
        <div className="mb-8 flex justify-center">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-on-accent">
              W
            </div>
            <div className="leading-tight">
              <div className="font-display text-sm font-bold text-ink">
                Wezesha
              </div>
              <div className="text-[10px] tracking-wider text-ink-muted uppercase">
                Restock OS
              </div>
            </div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

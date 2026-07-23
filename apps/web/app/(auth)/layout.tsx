import { ThemeToggle } from "@/components/ui/theme-toggle";

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-on-accent">
        W
      </div>
      <div className="leading-tight">
        <div className="font-display text-sm font-bold text-ink">Wezesha</div>
        <div className="text-[10px] tracking-wider text-ink-muted uppercase">
          Restock OS
        </div>
      </div>
    </div>
  );
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      {/* Brand panel — hidden on mobile, where the pages lead with the form. */}
      <aside className="relative hidden w-[44%] flex-col justify-between overflow-hidden border-r border-edge bg-sidebar p-10 lg:flex">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 -right-24 size-96 rounded-full bg-accent/10 blur-3xl" />
          <div className="absolute -bottom-32 -left-16 size-96 rounded-full bg-accent/15 blur-3xl" />
          <svg
            viewBox="0 0 200 200"
            fill="none"
            className="absolute right-[-60px] bottom-[-60px] size-80 text-accent/15"
          >
            <circle cx="100" cy="100" r="98" stroke="currentColor" strokeWidth="1" />
            <circle cx="100" cy="100" r="72" stroke="currentColor" strokeWidth="1" />
            <circle cx="100" cy="100" r="46" stroke="currentColor" strokeWidth="1" />
          </svg>
        </div>
        <div className="relative">
          <BrandMark />
        </div>
        <div className="relative max-w-md">
          <h2 className="font-display text-4xl font-bold tracking-tight text-ink-strong">
            Know what to restock before it runs out.
          </h2>
          <p className="mt-4 text-base text-ink-muted">
            Wezesha watches your sales and stock levels, forecasts demand, and
            turns it into a buy list you can act on.
          </p>
        </div>
        <p className="relative text-xs text-ink-faint">
          © {new Date().getFullYear()} Wezesha
        </p>
      </aside>

      <main className="relative flex flex-1 items-center justify-center px-4 py-12 md:px-8">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-100">
          <div className="mb-8 flex justify-center lg:hidden">
            <BrandMark />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

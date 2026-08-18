import { ButtonLink } from "@/components/ui/button";

/**
 * Root 404 — the last stop for anything outside the app shell, which is where
 * `/admin` lives. `requireAdmin()` answers a non-admin with `notFound()`
 * (deliberately, so the console never advertises itself), and that used to land
 * on Next's bare default page: no styling, no explanation, no way back.
 *
 * Standalone by design. The shell's own 404 renders inside the nav; this one
 * has to work for a caller who may have no workspace at all, so it borrows
 * nothing from it.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-page px-6">
      <div className="w-full max-w-sm text-center">
        <p className="text-sm font-semibold tracking-wider text-ink-muted uppercase">
          Wezesha
        </p>
        <h1 className="mt-2 text-xl font-semibold text-ink">That page isn&apos;t here</h1>
        <p className="mt-2 text-sm text-ink-muted">
          The link may be out of date, or you may not have access to it.
        </p>
        <ButtonLink href="/today" className="mt-6">
          Back to Today
        </ButtonLink>
      </div>
    </main>
  );
}

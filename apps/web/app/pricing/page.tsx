import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL } from "@/lib/legal";
import { planCards } from "@/lib/pricing";
import { formatNumber } from "@/lib/money";

export const metadata: Metadata = {
  title: "Pricing",
  description: `What ${LEGAL.product} costs, and what each plan includes.`,
};

/**
 * What the plans contain, and what they cost.
 *
 * Everything except the price is derived from the code that enforces it — the
 * feature map the app gates on and the limit table it counts against. A
 * hand-written pricing page is a promise nothing checks: it goes stale the
 * first time a feature moves tier, and the shop finds out by hitting a wall it
 * believed it had paid past.
 *
 * Public, and outside the app shell: someone reads this before they have an
 * account.
 */
export default function PricingPage() {
  const cards = planCards();

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-12">
      <header className="border-b border-edge pb-6">
        <p className="text-2xs tracking-wider text-ink-muted uppercase">Pricing</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink-strong">
          Plans that grow with the shop
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          Every plan includes the part that matters — a buy list that says what to reorder, how much,
          and when. The larger plans add branches, budgets and a bigger team.
        </p>
      </header>

      <div className="grid gap-4 pt-8 lg:grid-cols-3">
        {cards.map((card, index) => (
          <div
            key={card.tier}
            className="flex flex-col rounded-lg border border-edge bg-surface p-5 shadow-card"
          >
            <h2 className="text-lg font-semibold text-ink-strong">{card.name}</h2>
            <p className="mt-1 min-h-10 text-xs leading-relaxed text-ink-muted">{card.bestFor}</p>

            <p className="mt-4 font-mono text-2xl font-semibold text-ink">
              {card.monthlyKes == null ? (
                // A statement, not a second call to action: the button below
                // already says "Get a price", and the two read as a stutter
                // when both say the same thing.
                <span className="text-base font-medium text-ink-secondary">Priced per shop</span>
              ) : (
                <>
                  KES {formatNumber(card.monthlyKes)}
                  <span className="text-sm font-normal text-ink-muted"> / month</span>
                </>
              )}
            </p>

            <dl className="mt-4 space-y-1 border-t border-edge pt-4 text-xs text-ink-muted">
              <div className="flex justify-between gap-2">
                <dt>Products</dt>
                <dd className="font-mono text-ink">up to {formatNumber(card.limits.products)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>People</dt>
                <dd className="font-mono text-ink">up to {formatNumber(card.limits.members)}</dd>
              </div>
            </dl>

            <p className="mt-4 text-2xs font-medium tracking-wider text-ink-faint uppercase">
              {index === 0 ? "Includes" : `Everything below, plus`}
            </p>
            <ul className="mt-2 flex-1 space-y-1.5">
              {(index === 0 ? card.includes : card.adds).map((item) => (
                <li key={item} className="flex gap-2 text-xs leading-relaxed text-ink-secondary">
                  <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <Link
              href="/contact"
              className="mt-5 rounded-md border border-edge bg-surface-2 px-3 py-2 text-center text-sm font-medium text-ink hover:bg-surface"
            >
              {card.monthlyKes == null ? "Get a price" : "Talk to us"}
            </Link>
          </div>
        ))}
      </div>

      <section className="mt-10 border-t border-edge pt-6">
        <h2 className="text-lg font-semibold text-ink-strong">The details</h2>
        <dl className="mt-4 grid gap-6 sm:grid-cols-3">
          <div>
            <dt className="text-2xs font-medium tracking-wider text-ink-faint uppercase">Billing</dt>
            <dd className="mt-1 text-sm text-ink-secondary">
              Monthly, in Kenyan shillings. Annual on request.
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-medium tracking-wider text-ink-faint uppercase">Setup</dt>
            <dd className="mt-1 text-sm text-ink-secondary">
              We connect your shop and get your costs in with you — the numbers are only as good as
              what they are built from.
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-medium tracking-wider text-ink-faint uppercase">
              Commitment
            </dt>
            <dd className="mt-1 text-sm text-ink-secondary">
              Month to month. Your data stays yours, and you can export it whenever you like.
            </dd>
          </div>
        </dl>
      </section>

      <footer className="mt-10 border-t border-edge pt-6 text-2xs text-ink-faint">
        {/* One expression: JSX drops the space at a text/expression boundary,
            which shipped "Wezesha Restock· demand" to the page. */}
        {`${LEGAL.product} · demand & reorder intelligence for beauty retailers`}
        <span className="px-1.5">·</span>
        <Link href="/terms" className="hover:text-ink-muted">
          Terms
        </Link>
        <span className="px-1.5">·</span>
        <Link href="/privacy" className="hover:text-ink-muted">
          Privacy
        </Link>
      </footer>
    </main>
  );
}

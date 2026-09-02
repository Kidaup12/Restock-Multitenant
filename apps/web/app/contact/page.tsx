import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Contact",
  description: `How to reach the ${LEGAL.product} team.`,
};

/**
 * How to reach a person.
 *
 * A page, not a form. A form implies a queue behind it that answers, and this
 * is a small team without one — a contact form that drops messages into a
 * mailbox nobody has committed to watching is worse than an address, because it
 * looks like a promise. The mailbox here is the one already named in the
 * privacy policy, so there is exactly one address to keep working.
 *
 * The routes are separated by what the person needs, because "my sync stopped"
 * and "what does this cost" want different answers and different urgency.
 */
export default function ContactPage() {
  const routes = [
    {
      title: "Thinking about using it",
      body: "Tell us what you sell and roughly how many products you carry, and we will say plainly whether this will help you — and what it would cost.",
    },
    {
      title: "Already a customer",
      body: "Say which shop you are writing about. If something looks wrong on a screen, the product name and what you expected to see gets it fixed fastest.",
    },
    {
      title: "About your data",
      body: "Access, correction, export or deletion — anything covered by the privacy policy comes to the same address and is handled there.",
    },
  ];

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="border-b border-edge pb-6">
        <p className="text-2xs tracking-wider text-ink-muted uppercase">Contact</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink-strong">
          Talk to a person
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
          {LEGAL.entity}, {LEGAL.address}. One mailbox, watched by the people who build and run{" "}
          {LEGAL.product}.
        </p>
      </header>

      <div className="pt-8">
        <a
          href={`mailto:${LEGAL.privacyContact}`}
          className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-600"
        >
          {LEGAL.privacyContact}
        </a>
      </div>

      <div className="mt-8 space-y-5 border-t border-edge pt-6">
        {routes.map((route) => (
          <section key={route.title} className="space-y-1.5">
            <h2 className="text-sm font-semibold text-ink-strong">{route.title}</h2>
            <p className="text-sm leading-relaxed text-ink-secondary">{route.body}</p>
          </section>
        ))}
      </div>

      <section className="mt-8 space-y-1.5 border-t border-edge pt-6">
        <h2 className="text-sm font-semibold text-ink-strong">Already signed in?</h2>
        <p className="text-sm leading-relaxed text-ink-secondary">
          Most questions are answered on the screen they are about.{" "}
          <Link href="/getting-started" className="font-medium text-accent-ink hover:underline">
            How Wezesha works
          </Link>{" "}
          covers what runs on its own and what needs you, and{" "}
          <Link href="/settings/connections" className="font-medium text-accent-ink hover:underline">
            Connections
          </Link>{" "}
          shows whether your shop is syncing.
        </p>
      </section>

      <footer className="mt-10 border-t border-edge pt-6 text-2xs text-ink-faint">
        {/* One expression: JSX drops the space at a text/expression boundary,
            which shipped "Wezesha Restock· demand" to the page. */}
        {`${LEGAL.product} · demand & reorder intelligence for beauty retailers`}
        <span className="px-1.5">·</span>
        <Link href="/pricing" className="hover:text-ink-muted">
          Pricing
        </Link>
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

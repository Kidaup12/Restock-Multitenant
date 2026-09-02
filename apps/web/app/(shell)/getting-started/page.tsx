import type { Metadata } from "next";
import Link from "next/link";
import { requireSession, activeMembership } from "@/lib/auth";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { STAGES, FORMULA, FORMULA_NOTES } from "./content";

export const metadata: Metadata = {
  title: "How Wezesha works",
};

/**
 * What the product does on its own, what it needs once, and what it needs
 * every week.
 *
 * The app was built so each screen explains itself, which leaves nobody a place
 * to answer the question an owner actually opens with: how much of this is my
 * job? Without an answer, the honest assumption is "all of it", and a buy list
 * from a system you think you have to feed by hand is not worth following.
 *
 * Deliberately static. Every number on it would need a caveat, and a page whose
 * job is to set expectations should not itself be another dashboard.
 */
export default async function GettingStartedPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Getting started"
        title="How Wezesha works"
        description="It tells you what to reorder this week and how much, then builds the order for you. Most of what it needs arrives on its own — here is exactly what is automatic and what needs you."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {STAGES.map((stage) => (
          <Card key={stage.key}>
            <CardHeader title={stage.title} subtitle={stage.aside} />
            <CardContent className="space-y-3 pt-3">
              <span className="grid size-6 place-items-center rounded-full bg-accent-soft font-mono text-2xs font-semibold text-accent-ink">
                {stage.step}
              </span>
              <p className="text-sm text-ink-secondary">{stage.intro}</p>
              <ul className="space-y-2">
                {stage.points.map((point) => (
                  <li key={point} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="How a recommendation is made"
          subtitle="Every quantity is built the same way, so you can check it"
        />
        <CardContent className="space-y-3 pt-3">
          <p className="rounded-lg border border-edge bg-surface-2 px-4 py-3 text-sm text-ink">
            {FORMULA}
          </p>
          <ul className="space-y-2">
            {FORMULA_NOTES.map((note) => (
              <li key={note} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Ready to check your setup?"
          subtitle="Settings shows what is connected, and how much of your catalogue has a cost"
        />
        <CardContent className="flex flex-wrap gap-3 pt-3">
          <Link
            href="/settings"
            className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
          >
            Go to Settings
          </Link>
          <Link
            href="/today"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-600"
          >
            {membership ? "Open dashboard" : "Back to Wezesha"}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

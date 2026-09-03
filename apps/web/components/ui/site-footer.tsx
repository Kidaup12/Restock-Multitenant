import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * One footer, three surfaces.
 *
 * There were three hand-written copies within a day of each other and they had
 * already disagreed: the shell said "Wezesha Restock OS" and the two public
 * pages interpolated the LEGAL entity name, so the same tagline carried two
 * different product names depending on which page you were on. The legal name
 * belongs in the terms; the brand belongs here, and it is one string.
 *
 * The link set varies by surface — a signed-out reader on the pricing page
 * wants Contact, a signed-in one does not — so that is the only prop.
 */

const TAGLINE = "Wezesha Restock OS · demand & reorder intelligence for beauty retailers";

const LABELS = {
  pricing: "Pricing",
  contact: "Contact",
  terms: "Terms",
  privacy: "Privacy",
} as const;

export type FooterLink = keyof typeof LABELS;

export function SiteFooter({
  links = ["terms", "privacy"],
  className,
}: {
  links?: FooterLink[];
  className?: string;
}) {
  return (
    <footer className={cn("border-t border-edge pt-4 text-2xs text-ink-faint", className)}>
      {TAGLINE}
      {links.map((key) => (
        <span key={key}>
          <span className="px-1.5">·</span>
          <Link href={`/${key}`} className="hover:text-ink-muted">
            {LABELS[key]}
          </Link>
        </span>
      ))}
    </footer>
  );
}

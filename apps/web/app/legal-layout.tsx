import type { ReactNode } from "react";

/**
 * Shared chrome for the public legal pages. They sit outside the app shell —
 * a merchant reads the privacy policy before signing up, and Shopify's reviewer
 * reads it without an account at all — so they carry their own layout rather
 * than the authenticated one.
 *
 * Deliberately plain. These pages are read for their content, and a reviewer
 * checking a claim should not have to hunt for it.
 */

export function LegalPage({
  title,
  effective,
  children,
}: {
  title: string;
  effective: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="border-b border-edge pb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-strong">{title}</h1>
        <p className="mt-2 text-sm text-ink-muted">In effect from {effective}</p>
      </header>
      <div className="space-y-8 pt-8">{children}</div>
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-ink-strong">{title}</h2>
      {children}
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-ink-secondary">{children}</p>;
}

export function List({ items }: { items: readonly string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-secondary">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

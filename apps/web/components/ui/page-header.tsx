import Link from "next/link";

/** One step in the trail. The last crumb is the page you are on, so it carries
 *  no href. */
export type Crumb = { label: string; href?: string };

/**
 * The trail above the title on any page that is not a top-level section.
 *
 * A nested page reached by clicking a row has no other way back: the sidebar
 * highlights the section, not the record, so a purchase order or a product page
 * was a dead end unless you used the browser's Back button. Pages that grew
 * their own "← All products" link solved it one at a time and inconsistently;
 * this is the one place it lives now.
 */
function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-ink-muted">
        {items.map((crumb, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
              {crumb.href && !last ? (
                <Link href={crumb.href} className="transition-colors hover:text-ink">
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={last ? "text-ink" : undefined}>
                  {crumb.label}
                </span>
              )}
              {!last && (
                <span aria-hidden="true" className="text-ink-faint">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({
  breadcrumbs,
  title,
  description,
  actions,
}: {
  /** Ancestors then the current page, e.g. Orders / PO-0001. Omit on a
   *  top-level section — the sidebar already says where you are. */
  breadcrumbs?: Crumb[];
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} />}
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink-strong">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

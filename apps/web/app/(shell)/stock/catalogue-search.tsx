import Link from "next/link";
import { catalogueQueryFields, type CatalogueQuery } from "@/lib/catalogue";

/**
 * Free-text search over the catalogue. A shop with 400–1000 SKUs cannot find
 * one bottle by paging or by facet — the owner knows the product's name, not
 * which brand chip it hides under.
 *
 * A plain GET form rather than a typing-as-you-go control: every other filter
 * on this screen is a link the server answers, and the rows now live on the
 * server. Pushing a URL from a keystroke handler moves the address bar while
 * the table stands still (the note in catalogue-view says why), so the search
 * submits and the server returns the matching page — one navigation, one
 * answer, and a searched catalogue is linkable like any other view.
 *
 * The rest of the query rides as hidden fields: a GET form submits only its own
 * inputs, so without them searching would quietly discard the reader's scope,
 * facets, chip and sort.
 */
export function CatalogueSearch({
  query,
  matched,
  clearHref,
  view,
}: {
  query: CatalogueQuery;
  /** Rows matching everything currently applied — the answer to "did that find
   *  anything?", read straight from the aggregates the table paginates over. */
  matched: number;
  /** The same view with the text dropped. A link, not a second submit button:
   *  a button named `q` would post a second `q` alongside the input's own. */
  clearHref: string;
  view?: string;
}) {
  return (
    <form method="get" action="/stock" className="flex flex-wrap items-center gap-2 px-4 pt-3">
      {catalogueQueryFields(query, view ? { view } : undefined).map((f) => (
        <input key={`${f.name}:${f.value}`} type="hidden" name={f.name} value={f.value} />
      ))}
      <input
        name="q"
        type="search"
        defaultValue={query.search}
        placeholder="Search by product, SKU, variant, brand or category"
        aria-label="Search the catalogue"
        className="w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-ink sm:w-96"
      />
      <button
        type="submit"
        className="rounded-md border border-edge bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2"
      >
        Search
      </button>
      {query.search && (
        <>
          <span className="text-sm text-ink-muted">
            {matched === 0
              ? `Nothing matches “${query.search}”`
              : `${matched} ${matched === 1 ? "product matches" : "products match"} “${query.search}”`}
          </span>
          <Link
            href={clearHref}
            scroll={false}
            className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Clear
          </Link>
        </>
      )}
    </form>
  );
}

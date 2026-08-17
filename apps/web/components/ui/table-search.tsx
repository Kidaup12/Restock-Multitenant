import Link from "next/link";

/**
 * Free-text search over a long table. A shop cannot find one row by paging, and
 * facets only help when the reader knows which chip a thing hides under — they
 * usually know its name.
 *
 * A plain GET form rather than typing-as-you-go: these tables are rendered by
 * the server, and pushing a URL from a keystroke handler moves the address bar
 * while the rows stand still. Submitting means one navigation and one answer,
 * and a searched table stays linkable like any other view.
 *
 * `hidden` carries whatever else is in the query — a GET form submits only its
 * own inputs, so without it searching would quietly drop the reader's filters,
 * sort and tab. Every caller must pass its current query through it.
 *
 * The submit button hides while the box is empty (`peer` on the input, so no
 * client JS is needed to know that). An empty search offers nothing to do: with
 * no text it re-fetches the unfiltered list, which is what `Clear` is for. The
 * Enter key deliberately still submits, because emptying the box and pressing it
 * is how a reader clears a search they can see.
 */
export function TableSearch({
  action,
  value,
  hidden = [],
  placeholder,
  matched,
  clearHref,
  label = "Search",
}: {
  /** Route the form posts to, e.g. "/activity". */
  action: string;
  /** Current search text, so the box still shows what was searched. */
  value: string;
  /** The rest of the query as name/value pairs, preserved across the search. */
  hidden?: { name: string; value: string }[];
  placeholder: string;
  /** Rows matching everything applied — the answer to "did that find anything?".
   *  Null when nothing has been searched yet and a count would be noise. */
  matched?: number | null;
  /** The same view with the text dropped. A link, not a second submit button:
   *  a button named `q` would post a second `q` alongside the input's own. */
  clearHref: string;
  label?: string;
}) {
  return (
    <form method="get" action={action} className="flex flex-wrap items-center gap-2 px-5 pt-3">
      {hidden.map((f) => (
        <input key={`${f.name}:${f.value}`} type="hidden" name={f.name} value={f.value} />
      ))}
      <input
        type="search"
        name="q"
        defaultValue={value}
        placeholder={placeholder}
        aria-label={label}
        className="peer min-h-9 min-w-64 flex-1 rounded-md border border-edge bg-surface px-3.5 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent-500 focus:ring-4 focus:ring-accent-100"
      />
      <button
        type="submit"
        className="min-h-9 rounded-md border border-edge bg-surface px-3 text-2xs font-medium text-ink transition-colors hover:bg-surface-2 peer-placeholder-shown:hidden"
      >
        Search
      </button>
      {value && (
        <>
          <Link
            href={clearHref}
            className="min-h-9 rounded-md px-2 py-1.5 text-2xs text-ink-muted transition-colors hover:text-ink"
          >
            Clear
          </Link>
          {matched != null && (
            <span className="text-2xs text-ink-muted">
              {matched === 0 ? "No matches" : `${matched} match${matched === 1 ? "" : "es"}`}
            </span>
          )}
        </>
      )}
    </form>
  );
}

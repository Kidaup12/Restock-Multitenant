import Link from "next/link";
import type { LocationRole } from "@wezesha/db";
import { BoxIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import { formatEta } from "@/lib/dates";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import {
  Table,
  TableBody,
  TableCell,
  SortableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Pager } from "@/components/ui/pager";
import { TableSearch } from "@/components/ui/table-search";
import { InventoryExportBar } from "./inventory-export";
import { coverTone } from "@/lib/locations/roles";
import type { RawSearchParams } from "@/lib/catalogue";
import {
  getLocationsScreen,
  locationsQueryFields,
  locationsQueryToSearch,
  LOCATION_PAGE_SIZES,
  LOCATION_OPTIONAL_COLUMNS,
  LOCATION_COLUMN_LABELS,
  parseLocationsQuery,
  type LocationsQuery,
  type LocationSortKey,
  type LocationOptionalColumn,
} from "@/lib/data/stock";

const roleLabels: Record<LocationRole, string> = {
  sells: "Sells",
  holds: "Holds",
  enroute: "En route",
  ignore: "Ignore",
};

// One-line explanation of what this role does to the numbers.
const roleCaptions: Record<LocationRole, string> = {
  sells: "Counts as on-hand you can sell.",
  holds: "Warehouse stock — distributable, not counted as sellable cover.",
  enroute: "Stock en route to the shop — not counted as on-hand.",
  ignore: "Excluded from every number.",
};

const dotTone = { ok: "bg-positive", warn: "bg-warning", danger: "bg-negative" } as const;

function CoverCell({ daysCover, oversold }: { daysCover: number | null; oversold: boolean }) {
  const tone = coverTone(daysCover, oversold);
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className={cn("size-2 rounded-full", dotTone[tone])} aria-hidden />
      {oversold ? (
        <span className="text-negative">Oversold</span>
      ) : daysCover === null ? (
        "—"
      ) : (
        `${daysCover}d`
      )}
    </span>
  );
}

/**
 * Stock by location. A shop with three branches carries a couple of hundred
 * lines between them, most of them at one counter, so the table is searched and
 * paged: the window walks the lines in location order, and a location whose
 * lines cross a page break keeps its own card on both pages. What never moves
 * with the page or the search is any of the figures — the card's totals are the
 * location's, and the two shop-wide columns are the shop's.
 */
export async function LocationView({
  tenantId,
  canViewCosts = true,
  params = {},
}: {
  tenantId: string;
  canViewCosts?: boolean;
  /** The page's search params: the text and page live in the URL, so a searched
   *  branch is linkable and the back button walks the reader's own steps. */
  params?: RawSearchParams;
}) {
  const query = parseLocationsQuery(params);
  // canViewCosts flows into the query: per-line and per-location values come
  // back null for a money-blind member, so the figures never reach the payload.
  const screen = await getLocationsScreen(tenantId, { canViewCosts, query });

  if (screen.empty) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="No locations yet"
        description="Locations arrive with the first inventory sync."
      />
    );
  }

  /** Whether a column the reader may hide is currently showing. */
  const showing = (column: LocationOptionalColumn) => !query.hidden.includes(column);

  const sortHref = (sortKey: LocationSortKey, desc: boolean) =>
    hrefFor({ sortKey, desc, page: 0 });

  const hrefFor = (patch: Partial<LocationsQuery>) =>
    `/inventory${locationsQueryToSearch({ ...query, ...patch })}`;

  return (
    <div className="space-y-6">
      <Card className="pb-3">
        <TableSearch
          action="/inventory"
          value={query.search}
          hidden={locationsQueryFields(query)}
          placeholder="Search by product or SKU"
          matched={query.search ? screen.matched : null}
          clearHref={hrefFor({ search: "", page: 0 })}
          label="Search inventory by location"
        />
      </Card>

      {screen.locations.length === 0 && (
        <EmptyState
          icon={<BoxIcon />}
          title="No product matches"
          description="Nothing at any location matches that. Clear the search to see them all."
        />
      )}

      {screen.locations.map((location) => (
        <Card key={location.locationId}>
          <CardHeader
            title={location.name}
            subtitle={`${location.skuCount} SKUs · ${formatNumber(location.unitsOnHand)} units on hand · ${roleCaptions[location.role]}`}
            action={
              <div className="flex items-center gap-2">
                <Badge tone={location.isPrimary ? "accent" : "neutral"}>
                  {roleLabels[location.role]}
                </Badge>
                <CostValue
                  amount={location.stockValueKes}
                  canViewCosts={canViewCosts}
                  compact
                  className="text-sm font-medium text-ink"
                />
              </div>
            }
          />
          {/* Which of this location's lines are on screen. The header above
              counts everything the location holds, so without this a table
              narrowed by a search or cut by a page break would read as if the
              rest had gone missing. */}
          {(location.matchedLines < location.skuCount ||
            location.lines.length < location.matchedLines) && (
            <p className="px-5 pt-2 text-sm text-ink-muted">
              {[
                location.matchedLines < location.skuCount &&
                  `${location.matchedLines} of ${location.skuCount} lines match`,
                location.lines.length < location.matchedLines &&
                  `showing ${location.from}–${location.from + location.lines.length - 1}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          <div className="mt-2 pb-2">
            {location.lines.length === 0 ? (
              <p className="px-5 pb-4 text-sm text-ink-muted">Nothing on hand here.</p>
            ) : (
              <Table dense>
                <TableHeader>
                  <SortableHead label="Product" sortKey="title" startAsc activeKey={query.sortKey} desc={query.desc} hrefFor={sortHref} />
                  {showing("sku") && <SortableHead label="SKU" sortKey="sku" startAsc activeKey={query.sortKey} desc={query.desc} hrefFor={sortHref} />}
                  <SortableHead label="On hand" sortKey="onHand" numeric activeKey={query.sortKey} desc={query.desc} hrefFor={sortHref} />
                  {/* Both of these are shop-wide, and they say so. Cover is
                      total sellable stock against the shop's run rate — a
                      per-branch number needs sales attributed to the branch.
                      En route has no branch either: it counts stock already
                      moving plus what suppliers still owe the shop, and neither
                      names a destination. The columns stay put whatever the
                      location holds, so the table reads the same everywhere. */}
                  {/* Cover starts ascending: the shortest cover is the line
                      about to run out, which is the reason to open this screen. */}
                  {showing("daysCover") && (
                    <SortableHead label="Cover (shop)" sortKey="daysCover" numeric startAsc activeKey={query.sortKey} desc={query.desc} hrefFor={sortHref} />
                  )}
                  {showing("onOrderUnits") && (
                    <SortableHead label="En route (shop)" sortKey="onOrderUnits" numeric activeKey={query.sortKey} desc={query.desc} hrefFor={sortHref} />
                  )}
                  {showing("valueKes") && <SortableHead label="Value" sortKey="valueKes" numeric activeKey={query.sortKey} desc={query.desc} hrefFor={sortHref} />}
                </TableHeader>
                <TableBody>
                  {location.lines.map((line) => (
                    <TableRow key={line.productId}>
                      <TableCell className="font-medium text-ink">{line.title}</TableCell>
                      {showing("sku") && (
                        <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                      )}
                      <TableCell numeric className={cn(line.oversold && "text-negative")}>
                        {line.onHand}
                      </TableCell>
                      {showing("daysCover") && (
                        <TableCell numeric>
                          <CoverCell daysCover={line.daysCover} oversold={line.oversold} />
                        </TableCell>
                      )}
                      {showing("onOrderUnits") && (
                      <TableCell numeric className="text-ink-muted">
                        {line.onOrderUnits > 0 ? (
                          <span className="inline-flex flex-col items-end">
                            <span className="text-ink">{line.onOrderUnits}</span>
                            {/* An empty shelf with stock en route is not a
                                re-order — the date is what tells them apart. */}
                            <span className="text-xs text-ink-faint">
                              {line.expectedArrivalAt ? formatEta(line.expectedArrivalAt) : "no ETA"}
                            </span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      )}
                      {showing("valueKes") && (
                        <TableCell numeric>
                          <CostValue amount={line.valueKes} canViewCosts={canViewCosts} />
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>
      ))}

      {/* Which columns to keep. Hidden rather than shown in the URL, so a
          column added later appears for everyone instead of being invisible to
          every reader who has ever touched this control. Product and On hand
          are not on offer: a stock table without the product or the quantity is
          not a shorter table, it is a different one. */}
      <div className="flex flex-wrap items-center justify-end gap-2 px-1">
        {/* The screen someone takes to a stock count. It re-derives the whole
            matched list server-side rather than exporting the page on screen. */}
        <InventoryExportBar count={screen.matched} canViewCosts={canViewCosts} query={query} />
        <details className="relative">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm border border-edge bg-surface px-2.5 py-1.5 text-2xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink">
            Columns
            {query.hidden.length > 0 && (
              <span className="rounded-xs bg-surface-2/70 px-1.5 font-mono tabular-nums">
                {LOCATION_OPTIONAL_COLUMNS.length - query.hidden.length + 2}
              </span>
            )}
          </summary>
          <div className="absolute right-0 z-10 mt-1 flex min-w-40 flex-col gap-0.5 rounded-md border border-edge bg-surface p-1.5 shadow-pop">
            {LOCATION_OPTIONAL_COLUMNS.map((column) => {
              const on = showing(column);
              return (
                <Link
                  key={column}
                  href={hrefFor({
                    hidden: on
                      ? [...query.hidden, column]
                      : query.hidden.filter((c) => c !== column),
                    page: 0,
                  })}
                  scroll={false}
                  // The tick is decorative, so without this the accessible
                  // name is just "SKU" whether the column is showing or not —
                  // and the only way to find out was to toggle it and re-read
                  // the table. Naming the ACTION carries the state with it.
                  aria-label={`${on ? "Hide" : "Show"} the ${LOCATION_COLUMN_LABELS[column]} column`}
                  className="flex items-center gap-2 rounded-sm px-2 py-1 text-2xs text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-3.5 place-items-center rounded-xs border text-[9px]",
                      on ? "border-accent bg-accent text-on-accent" : "border-edge",
                    )}
                  >
                    {on ? "✓" : ""}
                  </span>
                  {LOCATION_COLUMN_LABELS[column]}
                </Link>
              );
            })}
          </div>
        </details>
      </div>

      {/* Offered whenever there is more than one page's worth: a branch with
          500 lines is a scroll, and hunting one product 50 at a time is paging
          rather than reading. Kept a closed set of sizes — the number reaches a
          slice, so an arbitrary one from the URL asks for the whole catalogue
          in a single response. */}
      {screen.matched > LOCATION_PAGE_SIZES[0] && (
        <div className="flex items-center justify-end gap-1.5 px-1 text-2xs text-ink-muted">
          <span>Per page</span>
          {LOCATION_PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={hrefFor({ pageSize: size, page: 0 })}
              scroll={false}
              aria-current={query.pageSize === size ? "true" : undefined}
              className={cn(
                "rounded-sm border px-2 py-1 font-mono transition-colors",
                query.pageSize === size
                  ? "border-accent-200 bg-accent-soft text-accent-ink"
                  : "border-edge bg-surface hover:bg-surface-2 hover:text-ink",
              )}
            >
              {size}
            </Link>
          ))}
        </div>
      )}

      {screen.pageCount > 1 && (
        <Card>
          <Pager
            page={screen.page}
            pageCount={screen.pageCount}
            from={screen.from}
            to={screen.to}
            total={screen.matched}
            pageHref={(next) => hrefFor({ page: next })}
            label="Stock by location pages"
          />
        </Card>
      )}
    </div>
  );
}

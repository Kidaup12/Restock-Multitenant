import { cn } from "@/lib/cn";

/* On small screens the table scrolls inside its container instead of squashing columns. */
export function Table({
  className,
  dense = false,
  children,
}: {
  className?: string;
  /** Narrows the column gutters for a table with enough columns to overflow its
   *  card on a laptop. Nine columns spend 360px on gutters alone, which is what
   *  pushed the row actions off the side of the suppliers table — the room comes
   *  back from the spacing rather than from dropping a column someone needs. */
  dense?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn(
          "w-full min-w-[560px] text-sm",
          dense && "[&_td]:px-3 [&_th]:px-3",
          className,
        )}
      >
        {children}
      </table>
    </div>
  );
}

export function TableHeader({ children }: { children: React.ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-edge bg-surface-2">{children}</tr>
    </thead>
  );
}

export function TableBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TableRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <tr
      className={cn(
        "border-b border-edge transition-colors last:border-0 hover:bg-surface-2/60",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TableHead({
  numeric = false,
  className,
  children,
}: {
  numeric?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-5 py-3 text-left text-2xs font-medium tracking-wider whitespace-nowrap text-ink-muted uppercase",
        numeric && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TableCell({
  numeric = false,
  className,
  children,
}: {
  numeric?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <td
      className={cn(
        "px-5 py-3 whitespace-nowrap text-ink-secondary",
        numeric && "text-right font-mono tabular-nums text-ink",
        className,
      )}
    >
      {children}
    </td>
  );
}

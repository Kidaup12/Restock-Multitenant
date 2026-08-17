import { cn } from "@/lib/cn";

/* On small screens the table scrolls inside its container instead of squashing columns. */
export function Table({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full min-w-[560px] text-sm", className)}>
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

import type { RunStatus } from "@/lib/api";

const styles: Record<RunStatus, string> = {
  complete: "bg-green-50 text-green-700 ring-green-600/20",
  running: "bg-amber-50 text-amber-700 ring-amber-600/20",
  failed: "bg-red-50 text-red-700 ring-red-600/20",
  halted: "bg-gray-100 text-gray-600 ring-gray-500/20",
  unknown: "bg-gray-100 text-gray-500 ring-gray-400/20",
};

export default function StatusBadge({ status }: { status: RunStatus }) {
  const cls = styles[status] ?? styles.unknown;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      {status === "running" && (
        <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
      )}
      {status}
    </span>
  );
}

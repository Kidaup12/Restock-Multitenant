"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listRuns, type RunListItem } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import StatusBadge from "./StatusBadge";

export default function RecentRuns() {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await listRuns();
        if (!cancelled) {
          setRuns(data);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Could not reach the API.");
      }
    }
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-base font-semibold text-gray-900">
        Recent runs
      </h2>
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {error ? (
          <p className="px-4 py-6 text-sm text-gray-500">{error}</p>
        ) : runs === null ? (
          <p className="px-4 py-6 text-sm text-gray-400">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500">
            No runs yet. Upload data or try the demo.
          </p>
        ) : (
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-400">
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Run ID</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((r) => (
                <tr key={`${r.client}/${r.run_id}`} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-medium text-gray-800">
                    {r.client}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-600">
                    {r.run_id}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500">
                    {fmtDate(r.created)}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      href={`/runs/${encodeURIComponent(r.client)}/${encodeURIComponent(r.run_id)}`}
                      className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

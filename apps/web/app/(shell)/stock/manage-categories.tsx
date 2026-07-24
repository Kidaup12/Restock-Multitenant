"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TrashIcon } from "@/components/icons";
import type { CategoryUsage } from "@/lib/data/stock";
import { deleteCategoryAction, renameCategoryAction, type CatalogueActionResult } from "./actions";

/**
 * Manage categories (spec §2): rename or delete the owner-defined groups. Delete
 * clears the field from its products (they keep working, uncategorised). New
 * categories are created by assigning a name inline in a product's row editor
 * (create-by-assign) — categories live on the product, not a separate table.
 */
export function ManageCategories({ categories }: { categories: CategoryUsage[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  function run(action: () => Promise<CatalogueActionResult>) {
    setMsg(null);
    start(async () => {
      const res = await action();
      setMsg(res.ok ? { tone: "ok", text: res.message ?? "Saved." } : { tone: "err", text: res.error });
      if (res.ok) router.refresh();
    });
  }

  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="group">
      <summary className="cursor-pointer list-none rounded-md border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-ink-muted hover:text-ink">
        Manage categories
      </summary>
      <div className="mt-2 w-80 space-y-2 rounded-lg border border-edge bg-surface p-3 shadow-lg">
        {categories.length === 0 && (
          <p className="text-sm text-ink-muted">
            No categories yet. Add one inline in a product&rsquo;s row editor.
          </p>
        )}
        {categories.map((c) => (
          <div key={c.name} className="flex items-center gap-2">
            <Input
              defaultValue={c.name}
              onChange={(e) => setDrafts((d) => ({ ...d, [c.name]: e.target.value }))}
              className="h-8 text-sm"
            />
            <span className="shrink-0 text-xs text-ink-faint">{c.count}</span>
            <Button
              size="sm"
              variant="ghost"
              loading={pending}
              onClick={() => {
                const to = (drafts[c.name] ?? c.name).trim();
                if (to && to !== c.name) run(() => renameCategoryAction({ from: c.name, to }));
              }}
            >
              Rename
            </Button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => deleteCategoryAction({ name: c.name }))}
              className="grid size-8 shrink-0 place-items-center rounded-md border border-edge text-ink-muted hover:border-negative hover:text-negative disabled:opacity-60"
              aria-label={`Delete ${c.name}`}
            >
              <TrashIcon className="size-4" />
            </button>
          </div>
        ))}
        {msg && <p className={msg.tone === "ok" ? "text-xs text-positive" : "text-xs text-negative"}>{msg.text}</p>}
      </div>
    </details>
  );
}

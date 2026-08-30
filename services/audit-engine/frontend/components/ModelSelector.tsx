"use client";

import { useEffect, useMemo, useState } from "react";
import { getModels, type ModelFamily, type ModelInfo } from "@/lib/api";

// Ordered family sections. `combo` is rendered as a separate "Combinations"
// block below the single-model families.
const FAMILY_LABELS: { family: ModelFamily; label: string }[] = [
  { family: "naive", label: "Naive" },
  { family: "smoother", label: "Smoothers" },
  { family: "intermittent", label: "Intermittent" },
  { family: "seasonal", label: "Seasonal" },
  { family: "broad", label: "Broad" },
];

export interface ModelSelectorProps {
  // Full set of currently-checked ids (models + combos), lifted to the parent.
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  // Called once the catalog loads so the parent can seed defaults if it hasn't
  // been touched yet.
  onCatalog?: (models: ModelInfo[], defaults: string[]) => void;
}

export default function ModelSelector({
  selected,
  onChange,
  onCatalog,
}: ModelSelectorProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getModels()
      .then((cat) => {
        if (cancelled) return;
        setModels(cat.models);
        setDefaults(cat.defaults);
        setLoading(false);
        onCatalog?.(cat.models, cat.defaults);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load models.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // onCatalog is intentionally excluded — we only want to load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo(() => {
    const byFamily = new Map<ModelFamily, ModelInfo[]>();
    for (const m of models) {
      const list = byFamily.get(m.family) ?? [];
      list.push(m);
      byFamily.set(m.family, list);
    }
    return byFamily;
  }, [models]);

  const combos = grouped.get("combo") ?? [];
  const nModels = models.filter(
    (m) => m.family !== "combo" && selected.has(m.id),
  ).length;
  const nCombos = combos.filter((m) => selected.has(m.id)).length;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function setMany(ids: string[], on: boolean) {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  }

  function resetToDefaults() {
    onChange(new Set(defaults));
  }

  if (loading) {
    return <p className="text-sm text-gray-400">Loading models…</p>;
  }
  if (error) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
        {error} The audit will use the engine&apos;s default roster.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">
          {nModels} model{nModels === 1 ? "" : "s"}, {nCombos} combination
          {nCombos === 1 ? "" : "s"} selected
        </p>
        <button
          type="button"
          onClick={resetToDefaults}
          className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
        >
          Reset to defaults
        </button>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        {FAMILY_LABELS.map(({ family, label }) => {
          const items = grouped.get(family) ?? [];
          if (items.length === 0) return null;
          return (
            <Section
              key={family}
              label={label}
              items={items}
              selected={selected}
              onToggle={toggle}
              onSetMany={setMany}
            />
          );
        })}
      </div>

      {combos.length > 0 && (
        <div className="mt-5 border-t border-gray-100 pt-4">
          <Section
            label="Combinations"
            items={combos}
            selected={selected}
            onToggle={toggle}
            onSetMany={setMany}
          />
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  items,
  selected,
  onToggle,
  onSetMany,
}: {
  label: string;
  items: ModelInfo[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSetMany: (ids: string[], on: boolean) => void;
}) {
  const ids = items.map((m) => m.id);
  const allOn = ids.every((id) => selected.has(id));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {label}
        </h4>
        <button
          type="button"
          onClick={() => onSetMany(ids, !allOn)}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-500"
        >
          {allOn ? "Select none" : "Select all"}
        </button>
      </div>
      <ul className="space-y-1.5">
        {items.map((m) => (
          <li key={m.id}>
            <label
              className="flex cursor-pointer items-start gap-2"
              title={m.blurb}
            >
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => onToggle(m.id)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500/30"
              />
              <span className="min-w-0">
                <span className="block text-sm text-gray-800">{m.name}</span>
                <span className="block truncate text-xs text-gray-400">
                  {m.blurb}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

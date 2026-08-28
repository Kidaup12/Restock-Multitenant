"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createDemo, createRun, type ModelInfo } from "@/lib/api";
import FileDrop from "./FileDrop";
import ModelSelector from "./ModelSelector";

export default function UploadCard() {
  const router = useRouter();
  const [sales, setSales] = useState<File | null>(null);
  const [stock, setStock] = useState<File | null>(null);
  const [client, setClient] = useState("");
  const [withModels, setWithModels] = useState(true);
  const [busy, setBusy] = useState<"run" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Model-selection disclosure. `customized` flips true once the user touches
  // the selector; until then we send nothing and the backend uses its defaults.
  const [modelsOpen, setModelsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customized, setCustomized] = useState(false);

  function handleSelectionChange(next: Set<string>) {
    setSelected(next);
    setCustomized(true);
  }

  function handleCatalog(_models: ModelInfo[], defaults: string[]) {
    // Seed the selector with the defaults only if the user hasn't touched it.
    if (!customized) setSelected(new Set(defaults));
  }

  // Split the chosen ids into models (M*) and combos (C*) for the API.
  function splitSelection(): { models: string[]; combos: string[] } {
    if (!customized) return { models: [], combos: [] };
    const ids = [...selected];
    return {
      models: ids.filter((id) => !id.startsWith("C")),
      combos: ids.filter((id) => id.startsWith("C")),
    };
  }

  const canRun = !!sales && client.trim().length > 0 && !busy;

  async function runAudit() {
    if (!sales) return;
    setBusy("run");
    setError(null);
    try {
      const { models, combos } = splitSelection();
      const res = await createRun({
        sales,
        stock,
        client: client.trim(),
        withModels,
        models,
        combos,
      });
      router.push(`/runs/${encodeURIComponent(res.client)}/${encodeURIComponent(res.run_id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start run.");
      setBusy(null);
    }
  }

  async function runDemo() {
    setBusy("demo");
    setError(null);
    try {
      const res = await createDemo();
      router.push(`/runs/${encodeURIComponent(res.client)}/${encodeURIComponent(res.run_id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start demo run.");
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900">New audit</h2>
      <p className="mt-1 text-sm text-gray-500">
        Upload a sales CSV (required) and a stock CSV (optional). The engine
        estimates lost sales from stockouts, dead stock, overstock and data
        quality.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <FileDrop label="Sales CSV" required file={sales} onFile={setSales} />
        <FileDrop label="Stock CSV" file={stock} onFile={setStock} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 sm:items-end">
        <div>
          <label
            htmlFor="client-name"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Client name<span className="ml-1 text-red-500">*</span>
          </label>
          <input
            id="client-name"
            type="text"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            placeholder="e.g. acme-retail"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-3 py-2">
          <button
            type="button"
            role="switch"
            aria-checked={withModels}
            onClick={() => setWithModels((v) => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              withModels ? "bg-indigo-600" : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                withModels ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
          <span className="text-sm text-gray-700">
            Run full model selection
          </span>
        </label>
      </div>

      <div className="mt-4 border-t border-gray-100 pt-4">
        <button
          type="button"
          onClick={() => setModelsOpen((v) => !v)}
          aria-expanded={modelsOpen}
          className="flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900"
        >
          <span
            className={`inline-block transition-transform ${
              modelsOpen ? "rotate-90" : ""
            }`}
            aria-hidden
          >
            &#9656;
          </span>
          Customise forecasting models
        </button>
        {!modelsOpen && (
          <p className="mt-1 text-xs text-gray-400">
            {customized
              ? "Custom selection will be used."
              : "Using the engine's default roster."}
          </p>
        )}
        {modelsOpen && (
          <div className="mt-3">
            <ModelSelector
              selected={selected}
              onChange={handleSelectionChange}
              onCatalog={handleCatalog}
            />
          </div>
        )}
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runAudit}
          disabled={!canRun}
          className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {busy === "run" ? "Starting…" : "Run Audit"}
        </button>
        <button
          type="button"
          onClick={runDemo}
          disabled={!!busy}
          className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400"
        >
          {busy === "demo" ? "Starting…" : "Try with demo data"}
        </button>
      </div>
    </section>
  );
}

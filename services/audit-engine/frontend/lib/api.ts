// Single client module for all audit-engine API access.
// Base URL comes from NEXT_PUBLIC_API_URL (default http://localhost:8000).

export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
).replace(/\/+$/, "");

export type RunStatus = "running" | "complete" | "failed" | "halted" | "unknown";

export interface RunListItem {
  client: string;
  run_id: string;
  status: RunStatus;
  created: string;
  has_report: boolean;
}

export interface RunSummary {
  lost_units_low: number | null;
  lost_units_high: number | null;
  lost_revenue_low: number | null;
  lost_revenue_high: number | null;
  episodes: number | null;
  dead_stock_value: number | null;
  overstock_value: number | null;
  total_stock_value: number | null;
  n_skus: number | null;
  routing_tier: string | null;
  selected_models?: string[] | null;
  selected_combos?: string[] | null;
}

export type ModelFamily =
  | "naive"
  | "smoother"
  | "intermittent"
  | "seasonal"
  | "broad"
  | "combo";

export interface ModelInfo {
  id: string;
  name: string;
  family: ModelFamily;
  intermittent: boolean;
  default: boolean;
  blurb: string;
}

export interface ModelsCatalog {
  models: ModelInfo[];
  defaults: string[];
}

export interface RunDetail {
  status: RunStatus;
  manifest: Record<string, unknown> | null;
  summary: RunSummary | null;
  error: string | null;
}

export interface RunCreated {
  client: string;
  run_id: string;
  status: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`API error ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function getHealth(): Promise<{ status: string }> {
  return json(await fetch(`${API_URL}/api/health`, { cache: "no-store" }));
}

export interface CreateRunInput {
  sales: File;
  stock?: File | null;
  client: string;
  withModels: boolean;
  models?: string[];
  combos?: string[];
}

export async function createRun(input: CreateRunInput): Promise<RunCreated> {
  const form = new FormData();
  form.append("sales", input.sales);
  if (input.stock) form.append("stock", input.stock);
  form.append("client", input.client);
  form.append("with_models", String(input.withModels));
  if (input.models && input.models.length > 0)
    form.append("models", input.models.join(","));
  if (input.combos && input.combos.length > 0)
    form.append("combos", input.combos.join(","));
  return json(await fetch(`${API_URL}/api/runs`, { method: "POST", body: form }));
}

export async function createDemo(): Promise<RunCreated> {
  return json(await fetch(`${API_URL}/api/demo`, { method: "POST" }));
}

export async function getModels(): Promise<ModelsCatalog> {
  return json(await fetch(`${API_URL}/api/models`, { cache: "no-store" }));
}

export async function listRuns(): Promise<RunListItem[]> {
  return json(await fetch(`${API_URL}/api/runs`, { cache: "no-store" }));
}

export async function getRun(client: string, runId: string): Promise<RunDetail> {
  return json(
    await fetch(
      `${API_URL}/api/runs/${encodeURIComponent(client)}/${encodeURIComponent(runId)}`,
      { cache: "no-store" },
    ),
  );
}

export function reportUrl(client: string, runId: string): string {
  return `${API_URL}/api/runs/${encodeURIComponent(client)}/${encodeURIComponent(runId)}/report`;
}

export function workbookUrl(client: string, runId: string): string {
  return `${API_URL}/api/runs/${encodeURIComponent(client)}/${encodeURIComponent(runId)}/workbook`;
}

export async function getHealthMd(client: string, runId: string): Promise<string> {
  const res = await fetch(
    `${API_URL}/api/runs/${encodeURIComponent(client)}/${encodeURIComponent(runId)}/health-md`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.text();
}

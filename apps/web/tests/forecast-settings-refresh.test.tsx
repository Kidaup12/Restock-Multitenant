import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const mock = vi.hoisted(() => ({ values: [] as unknown[], index: 0, pending: Promise.resolve(), save: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mock.index++;
    if (!(index in mock.values)) mock.values[index] = initial;
    return [mock.values[index], (value: unknown) => { mock.values[index] = value; }];
  },
  useTransition: () => [false, (fn: () => Promise<void>) => { mock.pending = fn(); }],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mock.refresh }) }));
vi.mock("../app/(shell)/settings/ordering-strategy/actions", () => ({ saveForecastSettings: mock.save }));
import { ForecastSettingsForm } from "../app/(shell)/settings/ordering-strategy/forecast-settings-form";
import { RunForecastButton } from "../app/(shell)/today/run-forecast-button";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function render(canManage = true) {
  mock.index = 0;
  return nodes(ForecastSettingsForm({ canManage, initial: { baselineMethod: "mean", abcWindowDays: 90, bigBuyerDamping: true } }));
}
async function submit() {
  (render().find(node => node.type === "form")!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
  await mock.pending;
}
beforeEach(() => { mock.values = []; mock.index = 0; vi.clearAllMocks(); });

it("offers the existing forecast action after settings persist successfully", async () => {
  mock.save.mockResolvedValue({ ok: true });
  expect(render().some(node => node.type === RunForecastButton)).toBe(false);
  await submit();
  expect(mock.save).toHaveBeenCalledWith({ baselineMethod: "mean", abcWindowDays: 90, bigBuyerDamping: true });
  expect(render().some(node => node.type === RunForecastButton)).toBe(true);
  expect(mock.refresh).toHaveBeenCalledOnce();
});
it("does not suggest running with settings that failed to save", async () => {
  mock.save.mockResolvedValue({ ok: false, error: "No settings access." });
  await submit();
  expect(render().some(node => node.type === RunForecastButton)).toBe(false);
  expect(render().find(node => node.props.role === "alert")!.props.children).toBe("No settings access.");
});
it("removes the run action if the settings permission is lost", async () => {
  mock.save.mockResolvedValue({ ok: true });
  await submit();
  expect(render(false).some(node => node.type === RunForecastButton)).toBe(false);
});

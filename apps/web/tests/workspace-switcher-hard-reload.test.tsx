import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

/**
 * Switching workspaces must force a full reload, not a soft client-side
 * refresh. router.refresh() only re-fetches the CURRENT route — it leaves
 * Next's client Router Cache for any OTHER route (a transfer detail page
 * visited under the old tenant, say) stale, so the next navigation there
 * could still show the previous tenant's data. The tenant boundary is a
 * security boundary, so only a hard navigation (which cannot carry a stale
 * cached route forward) is an acceptable fix here.
 */

const mock = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  index: 0,
  refIndex: 0,
  pending: Promise.resolve(),
  switchWorkspace: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = mock.index++;
    if (!(index in mock.values)) mock.values[index] = initial;
    return [mock.values[index], (value: unknown) => { mock.values[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = mock.refIndex++;
    if (!(index in mock.refs)) mock.refs[index] = { current: initial };
    return mock.refs[index];
  },
  useEffect: () => {},
  useTransition: () => [false, (fn: () => Promise<void>) => { mock.pending = fn(); }],
}));
vi.mock("@/lib/auth-actions", () => ({ switchWorkspace: mock.switchWorkspace }));

import { WorkspaceSwitcher } from "../components/shell/workspace-switcher";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function render() {
  mock.index = 0;
  mock.refIndex = 0;
  // open (the component's first useState) must start true, or the menu
  // branch never renders and there is nothing to click.
  mock.values[0] = true;
  return nodes(
    WorkspaceSwitcher({
      workspaces: [
        { id: "tenant-a", name: "Tenant A", roleLabel: "Owner" },
        { id: "tenant-b", name: "Tenant B", roleLabel: "Member" },
      ],
      activeId: "tenant-a",
    }),
  );
}

beforeEach(() => {
  mock.values = [];
  mock.refs = [];
  mock.index = 0;
  mock.refIndex = 0;
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { assign: mock.assign } });
});

it("hard-reloads after switching to a different workspace, instead of a soft router refresh", async () => {
  mock.switchWorkspace.mockResolvedValue({ ok: true });
  const menuItems = render().filter((n) => n.props.role === "menuitem" && n.props.onClick);
  const tenantB = menuItems[1]!;
  (tenantB.props.onClick as () => void)();
  await mock.pending;

  expect(mock.switchWorkspace).toHaveBeenCalledWith("tenant-b");
  expect(mock.assign).toHaveBeenCalledWith("/");
});

it("does not reload when the switch is rejected server-side", async () => {
  mock.switchWorkspace.mockResolvedValue({ ok: false });
  const menuItems = render().filter((n) => n.props.role === "menuitem" && n.props.onClick);
  const tenantB = menuItems[1]!;
  (tenantB.props.onClick as () => void)();
  await mock.pending;

  expect(mock.assign).not.toHaveBeenCalled();
});

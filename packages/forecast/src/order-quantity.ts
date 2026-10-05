/** Supplier minimum, shared by the planner, purchase orders, and owner reports. */
export function applyMoq(qty: number, moq: number): number {
  const wanted = Math.max(1, Math.ceil(qty));
  return Math.max(wanted, Math.max(1, Math.floor(moq) || 1));
}

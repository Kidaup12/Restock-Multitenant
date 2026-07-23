import { connection } from "next/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";

/* Placeholder rows until the forecast service exists. */
const suggestions = [
  {
    name: "Cantu Shea Butter Leave-In 340g",
    supplier: "Beauty Plus Distributors",
    qty: 48,
    cost: "124,800",
  },
  {
    name: "Nice & Lovely Glycerine 750ml",
    supplier: "Haria Industries",
    qty: 60,
    cost: "45,000",
  },
  {
    name: "Darling Empress Braid 3X",
    supplier: "Style Industries",
    qty: 36,
    cost: "25,200",
  },
];

export async function RestockSuggestions() {
  await connection();
  // Stands in for the forecast query so the Suspense fallback is visible.
  await new Promise((resolve) => setTimeout(resolve, 900));

  return (
    <Card>
      <CardHeader
        title="Restock suggestions"
        subtitle="What the forecast would order today"
        action={<Badge tone="accent">Suggested</Badge>}
      />
      <div className="mt-2 pb-2">
        {suggestions.map((s) => (
          <div
            key={s.name}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-edge px-5 py-3.5 last:border-0"
          >
            <div>
              <div className="text-sm font-medium text-ink">{s.name}</div>
              <div className="text-xs text-ink-muted">{s.supplier}</div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-xs text-ink-muted">{s.qty} units</span>
              <span className="font-mono text-sm text-ink tabular-nums">
                KES {s.cost}
              </span>
              <Button variant="ghost" size="sm">
                Add to plan
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

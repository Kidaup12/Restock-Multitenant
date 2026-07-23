"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertIcon,
  ArchiveIcon,
  BanknoteIcon,
  LayersIcon,
  PlusIcon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  SkeletonChart,
  SkeletonStatTile,
  SkeletonTableRows,
} from "@/components/ui/skeleton";
import { StatTile, type StatDelta } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/* Everything below is static placeholder data until the API lands. */

const stats: Array<{
  label: string;
  value: string;
  delta: StatDelta;
  icon: React.ReactNode;
}> = [
  {
    label: "Inventory value",
    value: "KES 1.55M",
    delta: { label: "+4.2% vs last week", tone: "positive", direction: "up" },
    icon: <BanknoteIcon />,
  },
  {
    label: "Tracked products",
    value: "312",
    delta: { label: "8 added this month", tone: "neutral" },
    icon: <LayersIcon />,
  },
  {
    label: "Stockouts",
    value: "8",
    delta: { label: "+3 since Monday", tone: "negative", direction: "up" },
    icon: <AlertIcon />,
  },
  {
    label: "Dead stock",
    value: "KES 214K",
    delta: { label: "23 SKUs, 90+ days idle", tone: "neutral" },
    icon: <ArchiveIcon />,
  },
];

/* Daily sales, KES thousands, oldest first. */
const sales14d = [62, 58, 71, 64, 80, 95, 88, 70, 74, 86, 92, 105, 98, 112];

const chart = { width: 560, height: 120, pad: 8 };

const sparkPoints = (() => {
  const min = Math.min(...sales14d);
  const max = Math.max(...sales14d);
  return sales14d.map((v, i) => {
    const x = (i / (sales14d.length - 1)) * chart.width;
    const y =
      chart.height -
      chart.pad -
      ((v - min) / (max - min)) * (chart.height - 2 * chart.pad);
    return `${x},${y}`;
  });
})();

const sparkLine = sparkPoints.join(" ");
const sparkArea = `${sparkLine} ${chart.width},${chart.height} 0,${chart.height}`;
const sparkEndTop = `${(Number(sparkPoints[sparkPoints.length - 1].split(",")[1]) / chart.height) * 100}%`;

const products = [
  {
    name: "Cantu Shea Butter Leave-In 340g",
    stock: "6",
    cover: "2 days",
    status: { label: "Reorder now", tone: "negative" as const },
    reorder: "48",
    value: "15,600",
  },
  {
    name: "Nice & Lovely Glycerine 750ml",
    stock: "0",
    cover: "—",
    status: { label: "Stocked out", tone: "negative" as const },
    reorder: "60",
    value: "0",
  },
  {
    name: "Darling Empress Braid 3X",
    stock: "14",
    cover: "4 days",
    status: { label: "Low", tone: "warning" as const },
    reorder: "36",
    value: "9,800",
  },
  {
    name: "Shea Moisture Coconut Shampoo 384ml",
    stock: "22",
    cover: "6 days",
    status: { label: "Low", tone: "warning" as const },
    reorder: "24",
    value: "30,800",
  },
  {
    name: "Garnier Even & Matte Serum 30ml",
    stock: "41",
    cover: "12 days",
    status: { label: "Healthy", tone: "positive" as const },
    reorder: "—",
    value: "53,300",
  },
  {
    name: "Flormar Matte Lipstick 04",
    stock: "12",
    cover: "9 days",
    status: { label: "Healthy", tone: "positive" as const },
    reorder: "—",
    value: "7,080",
  },
  {
    name: "Studio Line Styling Gel 200ml",
    stock: "68",
    cover: "45 days",
    status: { label: "Overstocked", tone: "neutral" as const },
    reorder: "—",
    value: "40,120",
  },
];

export function TodayDashboard() {
  const [loading, setLoading] = useState(true);

  /* Fakes the initial fetch so the skeleton -> content swap is visible. */
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 1200);
    return () => clearTimeout(t);
  }, [loading]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Today"
        description="Your replenishment picture this morning"
        actions={
          <>
            <Button
              variant="ghost"
              loading={loading}
              onClick={() => setLoading(true)}
            >
              Replay loading
            </Button>
            <Button>
              <PlusIcon className="size-4" />
              New order
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading
          ? stats.map((s) => <SkeletonStatTile key={s.label} />)
          : stats.map((s) => <StatTile key={s.label} {...s} />)}
      </div>

      <Card>
        <CardHeader
          title="Sales, last 14 days"
          subtitle="KES 1.16M total · KES 83K/day average"
          action={<Badge tone="positive">+12% vs prior 14 days</Badge>}
        />
        <CardContent>
          {loading ? (
            <SkeletonChart />
          ) : (
            <div>
              <div className="relative border-b border-edge">
                <svg
                  viewBox={`0 0 ${chart.width} ${chart.height}`}
                  preserveAspectRatio="none"
                  aria-label="Daily sales trend, last 14 days"
                  role="img"
                  className="h-28 w-full"
                >
                  <defs>
                    <linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        style={{ stopColor: "var(--accent)", stopOpacity: 0.25 }}
                      />
                      <stop
                        offset="100%"
                        style={{ stopColor: "var(--accent)", stopOpacity: 0 }}
                      />
                    </linearGradient>
                  </defs>
                  <polygon points={sparkArea} fill="url(#sales-fill)" />
                  <polyline
                    points={sparkLine}
                    fill="none"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    className="stroke-accent"
                  />
                </svg>
                <span
                  className="absolute right-0 size-2.5 -translate-y-1/2 translate-x-1/2 rounded-full border-2 border-surface bg-accent"
                  style={{ top: sparkEndTop }}
                />
              </div>
              <div className="mt-3 flex justify-between text-xs text-ink-muted">
                <span>10 Jul</span>
                <span>Today</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Needs attention"
          subtitle="Products ranked by stockout risk"
          action={
            <Link
              href="/stock"
              className="text-sm font-medium text-accent-ink hover:underline"
            >
              View all
            </Link>
          }
        />
        <div className="mt-2 pb-2">
          {loading ? (
            <SkeletonTableRows rows={7} />
          ) : (
            <Table>
              <TableHeader>
                <TableHead>Product</TableHead>
                <TableHead numeric>In stock</TableHead>
                <TableHead numeric>Days cover</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Reorder qty</TableHead>
                <TableHead numeric>Stock value (KES)</TableHead>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell className="font-medium text-ink">
                      {p.name}
                    </TableCell>
                    <TableCell numeric>{p.stock}</TableCell>
                    <TableCell numeric>{p.cover}</TableCell>
                    <TableCell>
                      <Badge tone={p.status.tone}>{p.status.label}</Badge>
                    </TableCell>
                    <TableCell numeric>{p.reorder}</TableCell>
                    <TableCell numeric>{p.value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
    </div>
  );
}

"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { editTransferLine } from "./actions";

export function LineQuantityEditor({ planId, lineId, qty, title }: { planId: string; lineId: string; qty: number; title: string }) {
  const [value, setValue] = useState(String(qty));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return <form className="min-w-40" onSubmit={event => {
    event.preventDefault(); setError(null);
    start(async () => {
      try {
        const result = await editTransferLine({ planId, lineId, qty: value.trim() === "" ? Number.NaN : Number(value) });
        if (!result.ok) { setError(result.error); return; }
        router.refresh();
      } catch { setError("Could not save the quantity. Try again."); }
    });
  }}>
    <div className="flex items-center gap-2">
      <Input aria-label={`Move quantity for ${title}`} type="number" min={0} step={1} required value={value} onChange={event => setValue(event.target.value)} className="w-20" size="sm" disabled={pending} />
      <Button type="submit" size="sm" variant="ghost" loading={pending} disabled={Number(value) === qty}>Save</Button>
    </div>
    {error && <p role="alert" className="mt-1 max-w-60 whitespace-normal text-xs text-negative">{error}</p>}
  </form>;
}

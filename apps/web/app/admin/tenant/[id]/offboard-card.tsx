"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";
import { deleteWorkspaceAction, exportWorkspaceAction } from "../../actions";
import { StepUpPrompt } from "../../step-up-prompt";

/**
 * Offboarding a customer: take their data out, then remove them.
 *
 * The order is the safety. Deleting refuses unless an export was taken in the
 * last 24 hours — enforced in `deleteTenant`, not here — because no restore has
 * ever been performed against the hosted database, so the export file IS the
 * recovery plan. The button below stays disabled until this session has taken
 * one, which makes the sequence visible rather than something you discover from
 * an error message.
 *
 * Deletion is a cascade and there is no undo.
 */
export function OffboardCard({
  tenantId,
  slug,
  name,
}: {
  tenantId: string;
  slug: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [exported, setExported] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState("");
  const [note, setNote] = useState<{ tone: "positive" | "negative"; text: string } | null>(null);
  const [stepUp, setStepUp] = useState<{ label: string; run: () => void } | null>(null);

  function doExport() {
    setNote(null);
    setStepUp(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("tenantId", tenantId);
      const res = await exportWorkspaceAction(form);
      if (!res.ok) {
        if (res.error === STEP_UP_REQUIRED) setStepUp({ label: `export ${name}`, run: doExport });
        else setNote({ tone: "negative", text: res.error });
        return;
      }
      // Straight to the operator's disk — the file is the recovery plan, so it
      // should exist somewhere other than a database they are about to drop.
      const url = URL.createObjectURL(new Blob([res.json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      setExported(true);
      setNote({ tone: "positive", text: `Exported ${res.filename}. Keep it somewhere safe.` });
    });
  }

  function doDelete() {
    setNote(null);
    setStepUp(null);
    if (
      !confirm(
        `Permanently delete ${name} and everything in it? This cascades across every table and cannot be undone.`
      )
    ) {
      return;
    }
    startTransition(async () => {
      const form = new FormData();
      form.set("tenantId", tenantId);
      form.set("confirmSlug", confirmSlug);
      const res = await deleteWorkspaceAction(form);
      if (res.ok) {
        router.push("/admin");
        router.refresh();
        return;
      }
      if (res.error === STEP_UP_REQUIRED) setStepUp({ label: `delete ${name}`, run: doDelete });
      else setNote({ tone: "negative", text: res.error });
    });
  }

  return (
    <Card>
      <CardHeader
        title="Offboarding"
        subtitle="Take the customer's data out, then remove the workspace"
      />
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={doExport} loading={pending}>
            Export everything
          </Button>
          <p className="text-xs text-ink-muted">
            Every table for this workspace as JSON. Deleting needs one from the last 24 hours.
          </p>
        </div>

        <div className="rounded-md border border-negative/40 bg-negative-soft/20 p-3 space-y-2">
          <p className="text-sm font-medium text-ink">Delete this workspace</p>
          <p className="text-xs text-ink-muted">
            Cascades across every table — products, orders, history, memberships. There is no
            undo, and no restore has ever been rehearsed against the live database. Type{" "}
            <span className="font-mono text-ink">{slug}</span> to confirm.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={confirmSlug}
              placeholder={slug}
              onChange={(e) => setConfirmSlug(e.target.value)}
              className="h-9 w-56 font-mono text-sm"
              aria-label="Type the workspace slug to confirm deletion"
            />
            <Button
              size="sm"
              variant="danger"
              onClick={doDelete}
              loading={pending}
              disabled={!exported || confirmSlug !== slug}
            >
              Delete permanently
            </Button>
          </div>
          {!exported && (
            <p className="text-xs text-ink-muted">Export first — the button unlocks after that.</p>
          )}
        </div>

        {stepUp && (
          <StepUpPrompt
            action={stepUp.label}
            onConfirmed={() => {
              const retry = stepUp.run;
              setStepUp(null);
              retry();
            }}
            onCancel={() => setStepUp(null)}
          />
        )}
        {note && (
          <p
            role={note.tone === "negative" ? "alert" : undefined}
            className={`text-sm ${note.tone === "negative" ? "text-negative" : "text-positive"}`}
          >
            {note.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

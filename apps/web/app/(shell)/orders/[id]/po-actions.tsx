"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cancelPoAction, sendPoAction } from "../actions";

/** Status-appropriate PO actions: email a draft to its supplier, cancel a
 *  draft/sent PO. Errors and confirmations surface inline. */
export function PoActions({
  poId,
  status,
  supplierEmail,
}: {
  poId: string;
  status: string;
  supplierEmail: string | null;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, startSending] = useTransition();
  const [cancelling, startCancelling] = useTransition();

  const send = () => {
    setError(null);
    setMessage(null);
    startSending(async () => {
      const result = await sendPoAction({ poId });
      if (result.ok) setMessage(result.message ?? null);
      else setError(result.error);
    });
  };

  const cancel = () => {
    if (!window.confirm("Cancel this purchase order? Its items go back to the queue.")) return;
    setError(null);
    setMessage(null);
    startCancelling(async () => {
      const result = await cancelPoAction({ poId });
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {status === "draft" && (
          <Button size="sm" onClick={send} loading={sending} disabled={!supplierEmail}>
            Email to supplier
          </Button>
        )}
        {(status === "draft" || status === "sent") && (
          <Button size="sm" variant="ghost" onClick={cancel} loading={cancelling}>
            Cancel
          </Button>
        )}
      </div>
      {status === "draft" && !supplierEmail && (
        <p className="text-xs text-ink-muted">Add a supplier email to send this PO</p>
      )}
      {message && <p className="text-xs text-positive">{message}</p>}
      {error && (
        <p className="text-xs text-negative" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

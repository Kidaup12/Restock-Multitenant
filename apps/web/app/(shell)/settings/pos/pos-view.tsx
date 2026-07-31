"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { disablePosIngest, rotatePosIngestSecret, setPosFeedSlug } from "./actions";

/**
 * Till-feed setup, in the order the person doing it needs: what state am I in,
 * what do I hand the till, and how do I turn it off.
 *
 * The secret appears exactly once, in the response that mints it. There is no
 * "reveal" control anywhere because the server holds only a SHA-256 of it — the
 * screen is honest about that rather than implying it could show it again.
 */

type Note = { tone: "positive" | "negative"; text: string } | null;

export function PosSetupView({
  canManage,
  configured,
  feedSlug,
  workspaceSlug,
  ingestUrl,
}: {
  canManage: boolean;
  configured: boolean;
  feedSlug: string | null;
  workspaceSlug: string;
  ingestUrl: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<Note>(null);
  /** Held in memory for this render only — never refetched, never persisted. */
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [slugDraft, setSlugDraft] = useState(feedSlug ?? "");

  const effectiveSlug = feedSlug ?? workspaceSlug;

  const run = (job: () => Promise<{ ok: boolean; message?: string; error?: string; secret?: string }>) => {
    setNote(null);
    startTransition(async () => {
      const result = await job();
      if (result.ok) {
        if (result.secret) setFreshSecret(result.secret);
        setNote({ tone: "positive", text: result.message ?? "Saved." });
        router.refresh();
      } else {
        setNote({ tone: "negative", text: result.error ?? "That didn't work." });
      }
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Status"
          subtitle="Whether this workspace is accepting sales from a till"
          action={
            configured ? (
              <Badge tone="positive">Accepting sales</Badge>
            ) : (
              <Badge tone="neutral">Not set up</Badge>
            )
          }
        />
        <CardContent>
          <p className="text-sm text-ink-secondary">
            {configured
              ? "Your till can post sales to Wezesha. They appear under Sales data, where anything that didn't match a product waits for you."
              : "Nothing can post sales to this workspace yet. Create a secret below and give it to whoever set up your till system."}
          </p>
          {!configured && (
            <p className="mt-2 text-sm text-ink-muted">
              Until then the forecast only sees online orders — which, for a shop that sells mostly
              over the counter, makes every run rate look far lower than it is.
            </p>
          )}
        </CardContent>
      </Card>

      {freshSecret && <SecretOnce secret={freshSecret} onDismiss={() => setFreshSecret(null)} />}

      <Card>
        <CardHeader title="What your till needs" subtitle="Give these to whoever configures it" />
        <CardContent className="space-y-3">
          <Detail label="Address to send to" value={ingestUrl} />
          <Detail label="Name to send under" value={effectiveSlug} />
          <Detail label="Secret" value={configured ? "Set — create a new one below if it's lost" : "Not created yet"} />
          <p className="text-xs text-ink-muted">
            Sales are sent as <code>POST</code> with the secret in an{" "}
            <code>Authorization: Bearer</code> header. Sending the same sale twice is safe — it is
            recorded once.
          </p>
        </CardContent>
      </Card>

      {canManage ? (
        <>
          <Card>
            <CardHeader
              title="Secret"
              subtitle="Shown once, when you create it — we don't keep a copy"
            />
            <CardContent>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" loading={pending} onClick={() => run(rotatePosIngestSecret)}>
                  {configured ? "Create a new secret" : "Create secret"}
                </Button>
                {configured && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pending}
                    onClick={() => run(disablePosIngest)}
                  >
                    Switch off till sales
                  </Button>
                )}
              </div>
              {configured && (
                <p className="mt-3 text-xs text-ink-muted">
                  Creating a new secret stops the old one working immediately, so your till will
                  need updating. Switching off closes the door entirely — nothing can post until you
                  create a secret again.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title="Name to send under"
              subtitle={`Blank uses your workspace name, ${workspaceSlug}`}
            />
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <span className="text-sm text-ink-muted">Feed name</span>
                  <input
                    value={slugDraft}
                    onChange={(e) => setSlugDraft(e.target.value)}
                    placeholder={workspaceSlug}
                    className="w-64 rounded-md border border-edge bg-surface px-3 py-2 text-sm text-ink"
                  />
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending}
                  onClick={() => run(() => setPosFeedSlug({ slug: slugDraft }))}
                >
                  Save
                </Button>
              </div>
              <p className="mt-3 text-xs text-ink-muted">
                Only worth changing if your till system needs a particular name. Changing it means
                updating the till too, or sales stop arriving.
              </p>
            </CardContent>
          </Card>
        </>
      ) : (
        <p className="text-sm text-ink-muted">
          You can see this setup but not change it — that needs settings access.
        </p>
      )}

      {note && (
        <p
          className={
            note.tone === "positive"
              ? "text-sm font-medium text-positive"
              : "text-sm font-medium text-negative"
          }
        >
          {note.text}
        </p>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge pb-2 last:border-0 last:pb-0">
      <span className="text-sm text-ink-muted">{label}</span>
      <code className="rounded bg-surface-2 px-2 py-1 font-mono text-xs text-ink">{value}</code>
    </div>
  );
}

/**
 * The one time the secret is visible. Deliberately loud, and deliberately not
 * dismissible by accident — once it is gone the only way back is a new secret,
 * which breaks whatever is already using this one.
 */
function SecretOnce({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card className="border-warning">
      <CardHeader
        title="Copy this now"
        subtitle="This is the only time it will be shown"
      />
      <CardContent className="space-y-3">
        <code className="block overflow-x-auto rounded-md border border-edge bg-surface-2 px-3 py-2 font-mono text-sm break-all text-ink">
          {secret}
        </code>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={copy}>
            {copied ? "Copied" : "Copy secret"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            I&apos;ve saved it
          </Button>
        </div>
        <p className="text-xs text-ink-muted">
          We store only a fingerprint of it, so we cannot show it again or recover it for you. If
          it&apos;s lost, create a new one and update your till.
        </p>
      </CardContent>
    </Card>
  );
}

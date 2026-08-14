import { prismaService } from "@wezesha/db";

/**
 * Worker-side outbound email seam — the counterpart of the web app's
 * lib/email.ts (the worker cannot import across apps, so the send logic is
 * mirrored). Everything the worker mails (reconnect alerts, weekly summaries)
 * goes through this one function.
 *
 * With RESEND_API_KEY set it posts to Resend's API over the runtime fetch (no
 * SDK); without one it logs to the worker console, which keeps local dev and
 * the tests working unchanged.
 *
 * In production a missing key is a hard error, not a fallback: a reconnect
 * alert that returns cleanly without leaving the building is a shop that never
 * hears its sync is broken. Every attempt lands in EmailLog (envelope only,
 * never the body); that write is best-effort and never changes whether the
 * send itself succeeded.
 *
 * Config is env only (see deploy/ENVIRONMENT.md):
 *   RESEND_API_KEY — Resend API key; unset = console fallback outside
 *                    production, a thrown error in it.
 *   EMAIL_FROM     — sender as "Name <address>" or a bare address. The domain
 *                    must be verified in Resend, or the send is rejected.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional rich body; providers fall back to `text` for plain-text clients. */
  html?: string;
  /** Workspace the send belongs to; omitted for mail that precedes one. */
  tenantId?: string | null;
  /** What kind of message this is, for the ledger ("reconnect_alert"). */
  kind?: string;
}

export type SendEmail = (message: EmailMessage) => Promise<void>;

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const NO_KEY = "RESEND_API_KEY is not set — refusing to report an unsent email as sent";

type LogEntry = {
  tenantId?: string | null;
  to: string;
  subject: string;
  kind?: string;
  status: "sent" | "skipped" | "failed";
  providerId?: string | null;
  error?: string | null;
};

/** Best-effort ledger write on the service client; never rethrows. */
const record = async (entry: LogEntry): Promise<void> => {
  try {
    await prismaService.emailLog.create({
      data: {
        tenantId: entry.tenantId ?? null,
        to: entry.to,
        subject: entry.subject,
        kind: entry.kind ?? null,
        status: entry.status,
        providerId: entry.providerId ?? null,
        error: entry.error ?? null,
      },
    });
  } catch (err) {
    console.warn("[email] could not write the delivery log", err);
  }
};

/** Resend returns the message id; absent or unreadable is not a send failure. */
const providerIdOf = async (res: Response): Promise<string | null> => {
  try {
    const body = (await res.json()) as { id?: unknown };
    return typeof body?.id === "string" ? body.id : null;
  } catch {
    return null;
  }
};

export const sendEmail = async (
  { to, subject, text, html, tenantId, kind }: EmailMessage,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> => {
  const envelope = { tenantId, to, subject, kind };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      await record({ ...envelope, status: "failed", error: NO_KEY });
      throw new Error(NO_KEY);
    }
    console.log(
      `[email] not sent (no RESEND_API_KEY)\n[email] to: ${to}\n[email] subject: ${subject}\n${text}`,
    );
    await record({ ...envelope, status: "skipped", error: "no RESEND_API_KEY (console fallback)" });
    return;
  }

  const from = process.env.EMAIL_FROM?.trim();
  if (!from) {
    const detail = "EMAIL_FROM is not set (required when RESEND_API_KEY is configured)";
    await record({ ...envelope, status: "failed", error: detail });
    throw new Error(detail);
  }

  const res = await fetchImpl(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    // Resend takes the sender as a single RFC-5322 string, so EMAIL_FROM passes
    // through as written rather than being split into name and address.
    body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const message = `Resend send failed (${res.status})${detail ? `: ${detail}` : ""}`;
    await record({ ...envelope, status: "failed", error: message });
    throw new Error(message);
  }

  await record({ ...envelope, status: "sent", providerId: await providerIdOf(res) });
};

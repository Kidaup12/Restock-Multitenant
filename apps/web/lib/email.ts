import { prismaService } from "@wezesha/db";

/**
 * Outbound email seam. Everything that sends mail (password resets, sign-in
 * codes, teammate invites, purchase orders) goes through this one function.
 * With RESEND_API_KEY set it posts to Resend's API over the runtime fetch (no
 * SDK); without one it logs to the server console, which keeps local dev and
 * the tests working unchanged.
 *
 * In production a missing key is a hard error, not a fallback. Outside it the
 * console fallback returns "skipped" rather than throwing, so the return value —
 * not the absence of an exception — is what says whether anything left the
 * building. A caller that reports delivery to a person must read it: saying
 * "emailed to the supplier" over a console log is a lie the shop acts on.
 *
 * Every attempt lands in EmailLog (envelope only — never the body, never an
 * attachment) so "did that
 * actually go out?" has an answer afterwards. The ledger write is best-effort:
 * an email that reached Resend stays sent even if the row cannot be written.
 *
 * Config is env only (see deploy/ENVIRONMENT.md):
 *   RESEND_API_KEY — Resend API key; unset = console fallback outside
 *                    production, a thrown error in it.
 *   EMAIL_FROM     — sender as "Name <address>" or a bare address. The domain
 *                    must be verified in Resend, or the send is rejected.
 */
/**
 * A file to send alongside the body — the supplier's copy of a purchase order,
 * for instance. `content` is the raw bytes; they are base64-encoded on the way
 * to the provider and never touch the ledger or the console.
 */
export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional rich body; providers fall back to `text` for plain-text clients. */
  html?: string;
  /** Files to send with the message; omitted entirely when there are none. */
  attachments?: EmailAttachment[];
  /** Workspace the send belongs to; omitted for mail that precedes one. */
  tenantId?: string | null;
  /** What kind of message this is, for the ledger ("purchase_order", "invite"). */
  kind?: string;
  /** The order this send belongs to, when it belongs to one. The ledger is read
   *  back by this rather than by the PO number in the subject, which is reused. */
  purchaseOrderId?: string | null;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const NO_KEY = "RESEND_API_KEY is not set — refusing to report an unsent email as sent";

type LogEntry = {
  tenantId?: string | null;
  to: string;
  subject: string;
  kind?: string;
  purchaseOrderId?: string | null;
  status: "sent" | "skipped" | "failed";
  providerId?: string | null;
  error?: string | null;
};

/**
 * Best-effort ledger write on the service client: the row often has no tenant
 * (sign-in codes precede one), and a ledger the tenant role could write is not
 * a ledger. Never rethrows — the send has already happened or already failed,
 * and losing the record must not change which.
 */
async function record(entry: LogEntry): Promise<void> {
  try {
    await prismaService.emailLog.create({
      data: {
        tenantId: entry.tenantId ?? null,
        to: entry.to,
        subject: entry.subject,
        kind: entry.kind ?? null,
        purchaseOrderId: entry.purchaseOrderId ?? null,
        status: entry.status,
        providerId: entry.providerId ?? null,
        error: entry.error ?? null,
      },
    });
  } catch (err) {
    console.warn("[email] could not write the delivery log", err);
  }
}

/** Resend returns the message id; absent or unreadable is not a send failure. */
async function providerIdOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { id?: unknown };
    return typeof body?.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

/** What became of the message. A failure throws, so these are the only two
 *  outcomes a caller can be handed. Mirrors the EmailLog row this writes. */
export type EmailOutcome = "sent" | "skipped";

export async function sendEmail(
  { to, subject, text, html, attachments, tenantId, kind, purchaseOrderId }: EmailMessage,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<EmailOutcome> {
  const envelope = { tenantId, to, subject, kind, purchaseOrderId };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      await record({ ...envelope, status: "failed", error: NO_KEY });
      throw new Error(NO_KEY);
    }
    // Attachments are named, never dumped: a purchase order's PDF carries the
    // supplier's costs and has no business in a log.
    const files = attachments?.length
      ? `\n[email] attached: ${attachments.map((a) => a.filename).join(", ")}`
      : "";
    console.log(
      `[email] not sent (no RESEND_API_KEY)\n[email] to: ${to}\n[email] subject: ${subject}${files}\n${text}`,
    );
    await record({ ...envelope, status: "skipped", error: "no RESEND_API_KEY (console fallback)" });
    return "skipped";
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
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
      // Resend takes attachment bytes base64-encoded in the JSON body.
      ...(attachments?.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.content).toString("base64"),
            })),
          }
        : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const message = `Resend send failed (${res.status})${detail ? `: ${detail}` : ""}`;
    await record({ ...envelope, status: "failed", error: message });
    throw new Error(message);
  }

  await record({ ...envelope, status: "sent", providerId: await providerIdOf(res) });
  return "sent";
}

import nodemailer, { type Transporter } from "nodemailer";
import { prismaService } from "@wezesha/db";

/**
 * Outbound email seam. Everything that sends mail (password resets, sign-in
 * codes, teammate invites, purchase orders, the weekly and monthly owner
 * reports, sync and forecast alerts) goes through this one function, so the
 * transport is chosen in exactly one place.
 *
 * Transport is Brevo over SMTP (nodemailer). With the BREVO_SMTP_* vars set it
 * connects to Brevo's relay; without them it logs to the server console, which
 * keeps local dev and the tests working unchanged.
 *
 * In production a missing key is a hard error, not a fallback. Outside it the
 * console fallback returns "skipped" rather than throwing, so the return value,
 * not the absence of an exception, is what says whether anything left the
 * building. A caller that reports delivery to a person must read it: saying it
 * emailed the supplier over a console log is a lie the shop acts on.
 *
 * Every attempt lands in EmailLog (envelope only, never the body, never an
 * attachment) so "did that actually go out?" has an answer afterwards. The
 * ledger write is best-effort: an email that reached Brevo stays sent even if
 * the row cannot be written.
 *
 * Config is env only (see deploy/ENVIRONMENT.md):
 *   BREVO_SMTP_HOST  smtp-relay.brevo.com
 *   BREVO_SMTP_PORT  587 (STARTTLS)
 *   BREVO_SMTP_LOGIN the Brevo SMTP login
 *   BREVO_SMTP_KEY   the Brevo SMTP key (a secret, never committed)
 *   EMAIL_FROM       sender as "Name <address>" or a bare address; the domain
 *                    must be authenticated in Brevo or the send is rejected.
 */

/**
 * A file to send alongside the body, the supplier's copy of a purchase order for
 * instance. `content` is the raw bytes; nodemailer takes them directly and they
 * never touch the ledger or the console.
 */
export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional rich HTML body; clients without HTML fall back to `text`. */
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

const NO_KEY = "BREVO_SMTP_KEY is not set — refusing to report an unsent email as sent";

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
 * a ledger. Never rethrows; the send has already happened or already failed,
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

/** The subset of a nodemailer transporter this seam uses. Narrowed so a test can
 *  hand in a fake without standing up a real SMTP connection. */
export type MailTransport = {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: { filename: string; content: Buffer }[];
  }): Promise<{ messageId?: string }>;
};

/** Built once and reused: nodemailer pools connections, and rebuilding per send
 *  would drop that. Null until the first send that has the config to build it. */
let shared: Transporter | null = null;
function brevoTransport(): MailTransport {
  if (shared) return shared;
  shared = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST ?? "smtp-relay.brevo.com",
    port: Number(process.env.BREVO_SMTP_PORT ?? 587),
    secure: false, // 587 is STARTTLS, upgraded after connect
    auth: { user: process.env.BREVO_SMTP_LOGIN, pass: process.env.BREVO_SMTP_KEY },
  });
  return shared;
}

/** What became of the message. A failure throws, so these are the only two
 *  outcomes a caller can be handed. Mirrors the EmailLog row this writes. */
export type EmailOutcome = "sent" | "skipped";

export async function sendEmail(
  { to, subject, text, html, attachments, tenantId, kind, purchaseOrderId }: EmailMessage,
  transport?: MailTransport,
): Promise<EmailOutcome> {
  const envelope = { tenantId, to, subject, kind, purchaseOrderId };
  const configured = Boolean(process.env.BREVO_SMTP_KEY) || transport != null;
  if (!configured) {
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
      `[email] not sent (no BREVO_SMTP_KEY)\n[email] to: ${to}\n[email] subject: ${subject}${files}\n${text}`,
    );
    await record({ ...envelope, status: "skipped", error: "no BREVO_SMTP_KEY (console fallback)" });
    return "skipped";
  }

  const from = process.env.EMAIL_FROM?.trim();
  if (!from) {
    const detail = "EMAIL_FROM is not set (required when BREVO_SMTP_KEY is configured)";
    await record({ ...envelope, status: "failed", error: detail });
    throw new Error(detail);
  }

  const mailer = transport ?? brevoTransport();
  let info: { messageId?: string };
  try {
    info = await mailer.sendMail({
      from,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
      ...(attachments?.length
        ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content) })) }
        : {}),
    });
  } catch (err) {
    const message = `Brevo send failed: ${err instanceof Error ? err.message : String(err)}`;
    await record({ ...envelope, status: "failed", error: message });
    throw new Error(message);
  }

  await record({ ...envelope, status: "sent", providerId: info.messageId ?? null });
  return "sent";
}

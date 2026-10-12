import nodemailer, { type Transporter } from "nodemailer";
import { prismaService } from "@wezesha/db";

/**
 * Worker-side outbound email seam, the counterpart of the web app's
 * lib/email.ts (the worker cannot import across apps, so the send logic is
 * mirrored). Everything the worker mails (reconnect alerts, weekly and monthly
 * owner reports, first-suggestion nudges) goes through this one function.
 *
 * Transport is Brevo over SMTP (nodemailer). With the BREVO_SMTP_* vars set it
 * connects to Brevo's relay; without them it logs to the worker console, which
 * keeps local dev and the tests working unchanged.
 *
 * In production a missing key is a hard error, not a fallback: a reconnect
 * alert that returns cleanly without leaving the building is a shop that never
 * hears its sync is broken. Every attempt lands in EmailLog (envelope only,
 * never the body); that write is best-effort and never changes whether the
 * send itself succeeded.
 *
 * Config is env only (see deploy/ENVIRONMENT.md):
 *   BREVO_SMTP_HOST  smtp-relay.brevo.com
 *   BREVO_SMTP_PORT  587 (STARTTLS)
 *   BREVO_SMTP_LOGIN the Brevo SMTP login
 *   BREVO_SMTP_KEY   the Brevo SMTP key (a secret, never committed)
 *   EMAIL_FROM       sender as "Name <address>" or a bare address; the domain
 *                    must be authenticated in Brevo or the send is rejected.
 *   EMAIL_REPLY_TO   optional Reply-To for every send (e.g. a monitored Gmail
 *                    inbox); the From stays on the authenticated domain.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional rich HTML body; clients without HTML fall back to `text`. */
  html?: string;
  /** Where replies should go; falls back to EMAIL_REPLY_TO. The From stays on
   *  the authenticated EMAIL_FROM domain either way. */
  replyTo?: string;
  /** Workspace the send belongs to; omitted for mail that precedes one. */
  tenantId?: string | null;
  /** What kind of message this is, for the ledger ("reconnect_alert"). */
  kind?: string;
}

/** The subset of a nodemailer transporter this seam uses, so a test can hand in
 *  a fake without a real SMTP connection. */
export type MailTransport = {
  sendMail(message: {
    from: string;
    to: string;
    replyTo?: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId?: string }>;
};

export type SendEmail = (message: EmailMessage, transport?: MailTransport) => Promise<void>;

const NO_KEY = "BREVO_SMTP_KEY is not set — refusing to report an unsent email as sent";

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

/** Built once and reused (nodemailer pools connections). Null until a send has
 *  the config to build it. */
let shared: Transporter | null = null;
const brevoTransport = (): MailTransport => {
  if (shared) return shared;
  shared = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST ?? "smtp-relay.brevo.com",
    port: Number(process.env.BREVO_SMTP_PORT ?? 587),
    secure: false, // 587 is STARTTLS, upgraded after connect
    auth: { user: process.env.BREVO_SMTP_LOGIN, pass: process.env.BREVO_SMTP_KEY },
  });
  return shared;
};

export const sendEmail: SendEmail = async ({ to, subject, text, html, replyTo, tenantId, kind }, transport) => {
  const envelope = { tenantId, to, subject, kind };
  const configured = Boolean(process.env.BREVO_SMTP_KEY) || transport != null;
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      await record({ ...envelope, status: "failed", error: NO_KEY });
      throw new Error(NO_KEY);
    }
    console.log(
      `[email] not sent (no BREVO_SMTP_KEY)\n[email] to: ${to}\n[email] subject: ${subject}\n${text}`,
    );
    await record({ ...envelope, status: "skipped", error: "no BREVO_SMTP_KEY (console fallback)" });
    return;
  }

  const from = process.env.EMAIL_FROM?.trim();
  if (!from) {
    const detail = "EMAIL_FROM is not set (required when BREVO_SMTP_KEY is configured)";
    await record({ ...envelope, status: "failed", error: detail });
    throw new Error(detail);
  }

  const reply = replyTo?.trim() || process.env.EMAIL_REPLY_TO?.trim() || undefined;

  const mailer = transport ?? brevoTransport();
  let info: { messageId?: string };
  try {
    info = await mailer.sendMail({ from, to, ...(reply ? { replyTo: reply } : {}), subject, text, ...(html ? { html } : {}) });
  } catch (err) {
    const message = `Brevo send failed: ${err instanceof Error ? err.message : String(err)}`;
    await record({ ...envelope, status: "failed", error: message });
    throw new Error(message);
  }

  await record({ ...envelope, status: "sent", providerId: info.messageId ?? null });
};

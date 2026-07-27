/**
 * Worker-side outbound email seam — the counterpart of the web app's
 * lib/email.ts (the worker cannot import across apps, so the send logic is
 * mirrored). Everything the worker mails (reconnect alerts, weekly summaries)
 * goes through this one function.
 *
 * With RESEND_API_KEY set it posts to Resend's API over the runtime fetch (no
 * SDK); without one it logs to the worker console, which keeps local dev and
 * the tests working unchanged and never throws.
 *
 * Config is env only (see deploy/ENVIRONMENT.md):
 *   RESEND_API_KEY — Resend API key; unset = console fallback.
 *   EMAIL_FROM     — sender as "Name <address>" or a bare address. The domain
 *                    must be verified in Resend, or the send is rejected.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional rich body; providers fall back to `text` for plain-text clients. */
  html?: string;
}

export type SendEmail = (message: EmailMessage) => Promise<void>;

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export const sendEmail = async (
  { to, subject, text, html }: EmailMessage,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      `[email] not sent (no RESEND_API_KEY)\n[email] to: ${to}\n[email] subject: ${subject}\n${text}`,
    );
    return;
  }

  const from = process.env.EMAIL_FROM?.trim();
  if (!from) {
    throw new Error("EMAIL_FROM is not set (required when RESEND_API_KEY is configured)");
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
    throw new Error(`Resend send failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
};

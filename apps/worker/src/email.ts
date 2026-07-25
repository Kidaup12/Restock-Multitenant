/**
 * Worker-side outbound email seam — the counterpart of the web app's
 * lib/email.ts (the worker cannot import across apps, so the send logic is
 * mirrored). Everything the worker mails (reconnect alerts, weekly summaries)
 * goes through this one function.
 *
 * With BREVO_API_KEY set it posts to Brevo's transactional API over the runtime
 * fetch (no SDK); without one it logs to the worker console, which keeps local
 * dev and the tests working unchanged and never throws.
 *
 * Config is env only (see deploy/ENVIRONMENT.md):
 *   BREVO_API_KEY — Brevo transactional API key; unset = console fallback.
 *   EMAIL_FROM    — sender as "Name <address>" or a bare address.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional rich body; providers fall back to `text` for plain-text clients. */
  html?: string;
}

export type SendEmail = (message: EmailMessage) => Promise<void>;

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/** Split EMAIL_FROM ("Name <address>" or "address") into Brevo's sender shape. */
function parseSender(from: string): { name?: string; email: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  const email = (match?.[2] ?? from).trim();
  const name = match?.[1]?.trim();
  return name ? { name, email } : { email };
}

export const sendEmail = async (
  { to, subject, text, html }: EmailMessage,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log(
      `[email] not sent (no BREVO_API_KEY)\n[email] to: ${to}\n[email] subject: ${subject}\n${text}`,
    );
    return;
  }

  const from = process.env.EMAIL_FROM?.trim();
  if (!from) {
    throw new Error("EMAIL_FROM is not set (required when BREVO_API_KEY is configured)");
  }

  const res = await fetchImpl(BREVO_ENDPOINT, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: parseSender(from),
      to: [{ email: to }],
      subject,
      textContent: text,
      ...(html ? { htmlContent: html } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo send failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
};

/**
 * Worker-side outbound email seam — the counterpart of the web app's
 * lib/email.ts (the worker cannot import across apps). Everything the worker
 * mails (reconnect alerts, weekly summaries) goes through this one function,
 * so wiring a real provider later is a change here only. Until then messages
 * are logged to the worker console.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (message: EmailMessage) => Promise<void>;

export const sendEmail: SendEmail = async ({ to, subject, text }) => {
  console.log(`[email] to: ${to}\n[email] subject: ${subject}\n${text}`);
};

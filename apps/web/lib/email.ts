/**
 * Outbound email seam. Everything that sends mail (password resets, sign-in
 * codes, future digests) goes through this one function, so wiring a real
 * provider later is a change here only. Until then messages are logged to the
 * server console, which is enough to complete the flows in development.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail({ to, subject, text }: EmailMessage): Promise<void> {
  console.log(`[email] to: ${to}\n[email] subject: ${subject}\n${text}`);
}

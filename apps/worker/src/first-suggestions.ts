import { prismaService } from "@wezesha/db";
import { sendEmail, type SendEmail } from "./email";
import { alertRecipients } from "./incident";

/**
 * "Your first buy list is ready" — the one email that marks a new shop reaching
 * first value, sent once and never again.
 *
 * It hangs off the forecast run rather than off sign-up, because the moment
 * worth writing about is not the account being created: it is the first time
 * the run has something to recommend. A shop that connects a store on Friday
 * and has a usable list on Saturday hears from us on Saturday.
 *
 * **Once-only lives in the send ledger**, not in a column of its own. EmailLog
 * already records every attempt with its kind, is never routinely pruned, and
 * is explicitly built to outlive what it describes — so "have we told them yet"
 * is a question it already answers. A failed attempt is deliberately not
 * counted, so a send that fell over is retried on the next run instead of
 * costing the shop the email entirely.
 *
 * That does couple the guard to the sender: it is `sendEmail` that writes the
 * ledger row, so an injected sender which does not log leaves this able to send
 * twice. Every caller in the app uses the default, and the suite's fake writes
 * the row exactly as the real one does — but a sender that skips the ledger is
 * the way this breaks, and it would break silently.
 */

/**
 * Workspaces that already existed when this email was written never receive it.
 *
 * Without a line like this the first run after deploy would greet every
 * established shop with a welcome — the six on production at the time were all
 * between eighteen and twenty-eight days old, so any "recently created" window
 * wide enough to be useful would have caught the lot. A fixed date is blunt but
 * it is honest about what it does, and it cannot drift with the clock.
 */
export const FIRST_SUGGESTIONS_FROM = new Date("2026-08-26T00:00:00.000Z");

export type FirstSuggestionsOutcome =
  | "sent"
  | "already_sent"
  | "workspace_predates_the_email"
  | "nothing_to_suggest"
  | "no_recipients"
  | "unknown_tenant";

/**
 * Send it if this is the moment. Returns why not when it isn't, so a caller (or
 * a test) can tell "we chose not to" from "it failed" — a bare false hid the
 * difference and made every guard look alike.
 */
export async function sendFirstSuggestions(
  tenantId: string,
  send: SendEmail = sendEmail
): Promise<FirstSuggestionsOutcome> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- system path: the tenantId is the job's own and there is no session to resolve through.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, createdAt: true },
  });
  if (!tenant) return "unknown_tenant";
  if (tenant.createdAt < FIRST_SUGGESTIONS_FROM) return "workspace_predates_the_email";

  const alreadySent = await prismaService.emailLog.count({
    where: { tenantId, kind: "first_suggestions", status: { not: "failed" } },
  });
  if (alreadySent > 0) return "already_sent";

  // Something to actually look at. A run that recommends nothing is not first
  // value, and greeting someone with an empty list is worse than staying quiet.
  const worthBuying = await prismaService.prediction.count({
    where: { tenantId, recommendedQty: { gt: 0 } },
  });
  if (worthBuying === 0) return "nothing_to_suggest";

  const recipients = await alertRecipients(tenantId, "first_suggestions");
  if (!recipients) return "no_recipients";

  for (const to of recipients.emails) {
    await send({
      to,
      subject: `Your first buy list is ready — ${tenant.name}`,
      text:
        `${tenant.name} has enough sales history for its first buy list.\n\n` +
        `${worthBuying} ${worthBuying === 1 ? "product needs" : "products need"} restocking. ` +
        `Open the Restock Planner to see what to order, how much, and why.\n\n` +
        `Nothing is ordered until you tick it — the list is a recommendation, not an order.`,
      tenantId,
      kind: "first_suggestions",
    });
  }
  return "sent";
}

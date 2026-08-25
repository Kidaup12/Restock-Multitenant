/**
 * Which optional emails a workspace still wants.
 *
 * Only two messages are sent on the app's initiative rather than a person's:
 * the weekly summary, and the alert that a feed has stopped arriving. Those are
 * the ones a shop can silence. Everything else the app sends — an invite, a
 * sign-in code, a password reset, the purchase order itself — is the answer to
 * something someone just did, and is deliberately not mutable here: a shop that
 * had switched off its own purchase-order emails would be a support call, not a
 * preference.
 *
 * The in-app notification feed is unaffected either way. Silencing an email
 * stops the mail, not the record — the bell still shows what happened.
 *
 * **Absent means on.** The column is null for every member who has never opened
 * the setting, and someone who has said nothing should keep hearing from us.
 * Only an explicit `false` silences a kind, so a new key added here defaults to
 * sending rather than to silence.
 *
 * Stored per MEMBERSHIP, not per user and not per workspace: the same person
 * can follow one shop closely and leave another alone, and two people in one
 * shop can disagree. The one exception is a workspace with an alert email set —
 * that address is not a member and has no preferences, so a shop that has
 * deliberately centralised its mail keeps doing exactly that.
 */

export const OPTIONAL_EMAIL_KINDS = ["weekly_summary", "reconnect_alert"] as const;

export type OptionalEmailKind = (typeof OPTIONAL_EMAIL_KINDS)[number];

/** Stored on TenantConfig.notifyPrefs. Partial on purpose — see "absent means on". */
export type NotifyPrefs = Partial<Record<OptionalEmailKind, boolean>>;

/** What the setting is called on screen, in the shop's terms rather than ours. */
export const OPTIONAL_EMAIL_LABELS: Record<OptionalEmailKind, { title: string; body: string }> = {
  weekly_summary: {
    title: "Weekly stock summary",
    body: "One email a week: what sold, what needs restocking, and what is tying up cash.",
  },
  reconnect_alert: {
    title: "Sync stopped working",
    body: "Tells you once when your store stops sending data, so the numbers here do not go quietly stale.",
  },
};

/** Read the JSON column defensively — it is hand-editable and may hold anything. */
export function parseNotifyPrefs(value: unknown): NotifyPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: NotifyPrefs = {};
  for (const kind of OPTIONAL_EMAIL_KINDS) {
    if (typeof raw[kind] === "boolean") out[kind] = raw[kind] as boolean;
  }
  return out;
}

/** True unless the workspace has explicitly turned this kind off. */
export function wantsEmail(value: unknown, kind: OptionalEmailKind): boolean {
  return parseNotifyPrefs(value)[kind] !== false;
}

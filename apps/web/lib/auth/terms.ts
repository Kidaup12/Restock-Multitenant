import { prismaForTenant } from "@wezesha/db";
import { TERMS_VERSION } from "@/lib/legal";

/**
 * Whether a member has accepted the terms currently published, and when.
 *
 * The two columns existed for a long time with nothing reading or writing them,
 * while the schema claimed they were enforced — so the app showed a signup
 * notice ("by creating an account you agree to…") and kept no record that
 * anyone had. This is the record.
 *
 * The RECORD is per membership — it says which workspace someone was in when
 * they agreed — but the QUESTION is asked once per person. Those were the same
 * thing until it turned out they are not: a browser with no workspace cookie
 * resolves to the user's earliest membership, so anyone in two workspaces was
 * asked again on a machine they had never signed in from, having already
 * agreed. Consent they have given should not be re-demanded because the app
 * picked a different workspace to greet them with.
 *
 * Acceptance is version-stamped, so re-publishing the terms DOES re-open the
 * question — that one is deliberate. Inheriting consent to wording nobody has
 * seen is the thing this stamp exists to prevent.
 */

type Stamp = { acceptedTermsAt: Date | null; acceptedTermsVersion: string | null };

export type TermsAcceptance = {
  /** Accepted the version now published. */
  current: boolean;
  /** When they last accepted anything, null if never. */
  at: Date | null;
  /** The version they accepted, null if never. Differs from TERMS_VERSION when
   *  the text has moved on since. */
  version: string | null;
};

export function readTermsAcceptance(membership: Stamp): TermsAcceptance {
  const { acceptedTermsAt, acceptedTermsVersion } = membership;
  return {
    current: acceptedTermsAt !== null && acceptedTermsVersion === TERMS_VERSION,
    at: acceptedTermsAt,
    version: acceptedTermsVersion,
  };
}

/**
 * Record acceptance of the published version for one membership.
 *
 * Stamps the version alongside the time so the record says WHAT was accepted,
 * not merely that something was. Re-accepting after a version bump overwrites
 * the previous stamp: the ledger of interest is "did they accept what is
 * published now", and the audit trail carries the history.
 */
export async function recordTermsAcceptance(
  tenantId: string,
  membershipId: string,
): Promise<TermsAcceptance> {
  const updated = await prismaForTenant(tenantId).membership.update({
    where: { id: membershipId },
    data: { acceptedTermsAt: new Date(), acceptedTermsVersion: TERMS_VERSION },
    select: { acceptedTermsAt: true, acceptedTermsVersion: true },
  });
  return readTermsAcceptance(updated);
}

/**
 * Whether this person has accepted the published terms anywhere.
 *
 * The gate's question. It spans the user's memberships because the person is
 * the one being asked: they have read this version of the terms or they have
 * not, and which workspace happened to be active when they said so is a fact
 * about the record, not about their consent.
 */
export function hasAcceptedCurrentTerms(memberships: Stamp[]): boolean {
  return memberships.some((m) => readTermsAcceptance(m).current);
}

/**
 * Whether the shell should raise the terms gate for this visit.
 *
 * The layout's own decision, pulled out so it can be tested. The bug this
 * encodes was in the CALLER, not the predicate: the gate judged the ACTIVE
 * membership while a cookie-less browser resolves to the earliest workspace, so
 * someone in two workspaces was re-asked on a new machine. It has to ask across
 * ALL of them (`memberships`), never the one that happened to be active — and a
 * visitor with no workspace at all is never gated.
 */
export function shouldShowTermsGate(
  membership: Stamp | null,
  memberships: Stamp[],
): boolean {
  if (!membership) return false;
  return !hasAcceptedCurrentTerms(memberships);
}

/**
 * The acceptance to SHOW this person, across their workspaces.
 *
 * Settings and the gate have to answer alike. Once the gate stopped asking a
 * person who had agreed elsewhere, a Settings card reading "not accepted" on a
 * workspace whose row is unstamped would tell them the opposite of what the
 * app just decided — with a button offering to do the thing they had done.
 * Prefers a current acceptance (the most recent one), and falls back to the
 * active membership so a person who has never accepted still sees their own
 * empty record rather than someone else's.
 */
export function effectiveTermsAcceptance(
  active: Stamp,
  memberships: Stamp[],
): TermsAcceptance {
  const current = memberships
    .filter((m) => readTermsAcceptance(m).current)
    .sort((a, b) => (b.acceptedTermsAt?.getTime() ?? 0) - (a.acceptedTermsAt?.getTime() ?? 0))[0];
  return readTermsAcceptance(current ?? active);
}

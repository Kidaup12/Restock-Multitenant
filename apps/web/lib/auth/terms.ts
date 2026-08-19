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
 * Acceptance is per MEMBERSHIP, not per user: someone who belongs to two
 * workspaces accepts once for each, because it is the business that is bound
 * (terms §1: "if you accept on behalf of a business…"). Acceptance is also
 * version-stamped, so re-publishing the terms re-opens the question rather than
 * silently inheriting consent to wording nobody agreed to.
 */

export type TermsAcceptance = {
  /** Accepted the version now published. */
  current: boolean;
  /** When they last accepted anything, null if never. */
  at: Date | null;
  /** The version they accepted, null if never. Differs from TERMS_VERSION when
   *  the text has moved on since. */
  version: string | null;
};

export function readTermsAcceptance(membership: {
  acceptedTermsAt: Date | null;
  acceptedTermsVersion: string | null;
}): TermsAcceptance {
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

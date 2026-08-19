/**
 * The facts the legal pages state about who we are and what we run on.
 *
 * Kept in one place because the privacy policy and the merchant terms have to
 * agree with each other, and because the details below are the ONLY part of
 * those documents that a lawyer or the business has to supply — everything else
 * is a description of what the code does.
 *
 * These were placeholders until the operating business supplied them; a privacy
 * policy naming no legal entity is not a privacy policy, and both documents were
 * live with "PLACEHOLDER" in them. `effective` dates THIS text, not any other
 * version of the terms — move it only when the wording here changes.
 */

export const LEGAL = {
  /** Registered name of the entity that operates the service. */
  entity: "SimplyDone Africa",
  /** Postal address of that entity. */
  address: "Nairobi, Kenya",
  /** Where a merchant writes about their data. A monitored mailbox, not a person. */
  privacyContact: "teamsimplydone@gmail.com",
  /** Governing law for the merchant terms. */
  jurisdiction: "Kenya",

  /** Product name as merchants see it. */
  product: "Wezesha Restock",
  /** Date these versions took effect. Bump when the text changes materially. */
  effective: "29 July 2026",
} as const;

/**
 * The wording a member's acceptance is recorded against.
 *
 * Stored on the membership beside the timestamp, so an acceptance stays
 * attached to the text that was actually shown. Move it in the SAME change that
 * edits the terms — an acceptance recorded against wording nobody can retrieve
 * proves nothing. It is a plain date string rather than the display form of
 * `effective` because it is compared, not read aloud.
 */
export const TERMS_VERSION = "2026-07-29";

/**
 * Every third party that processes merchant data on our behalf, and why.
 *
 * This list is a compliance artefact: a data-protection agreement obliges us to
 * name our sub-processors, and adding one without listing it here is the kind of
 * omission that turns a good-faith answer into a false one. If a new service
 * starts touching tenant data, it belongs on this list in the same change.
 */
export const SUB_PROCESSORS = [
  {
    name: "Supabase",
    purpose: "Managed PostgreSQL — the database holding all workspace data",
    region: "Ireland (eu-west-1)",
  },
  {
    name: "Vercel",
    purpose: "Hosting for the web application",
    region: "Dublin (dub1), co-located with the database",
  },
  {
    name: "Railway",
    purpose: "Background sync worker, job queue and realtime gateway",
    region: "United States",
  },
  {
    name: "Resend",
    purpose: "Transactional email — invites, password resets, weekly summaries",
    region: "United States",
  },
  {
    name: "Shopify",
    purpose: "Source of the catalogue, inventory and order data the app reads",
    region: "Merchant's own store region",
  },
] as const;

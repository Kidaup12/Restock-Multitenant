/**
 * The one Intuit app, and which set of hosts it talks to.
 *
 * Unlike Shopify — where each shop registers its own app and the credentials
 * live per tenant — QuickBooks has a single app that every workspace connects
 * to. So the client id and secret are app-level environment variables, and what
 * we keep per tenant is the company (realmId) and its tokens.
 *
 * The client id is not a secret: it travels in the authorize URL the owner's own
 * browser visits. The secret is, and is read lazily so this module imports
 * cleanly before the environment is set and tests can supply their own.
 */

export type QuickBooksEnvironment = "sandbox" | "production";

export type QuickBooksAppCredentials = {
  clientId: string;
  clientSecret: string;
};

/** Read the app credentials, or throw with the variable that is missing. */
export function appCredentials(): QuickBooksAppCredentials {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId) throw new Error("QUICKBOOKS_CLIENT_ID is not set.");
  if (!clientSecret) throw new Error("QUICKBOOKS_CLIENT_SECRET is not set.");
  return { clientId, clientSecret };
}

/**
 * Sandbox unless explicitly told otherwise.
 *
 * Defaulting to sandbox is the safe way round: an unset variable in a new
 * deployment reads a developer's test company, where the wrong answer is
 * meaningless data. Defaulting to production would have the same misconfiguration
 * read a real business's books.
 */
export function quickBooksEnvironment(): QuickBooksEnvironment {
  return process.env.QUICKBOOKS_ENVIRONMENT === "production" ? "production" : "sandbox";
}

/** Accounting API host for the current environment. */
export function apiBaseUrl(env: QuickBooksEnvironment = quickBooksEnvironment()): string {
  return env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

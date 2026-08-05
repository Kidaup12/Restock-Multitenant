/**
 * Turn whatever a merchant pasted into the canonical `<store>.myshopify.com`.
 *
 * Connecting a store is a first-run step, and the obvious thing to do is copy
 * the URL out of the browser. Every one of those forms used to be passed
 * through untouched and rejected by the install route as an invalid domain —
 * a raw 400 on the screen that matters most.
 *
 * Handles: a bare handle, the admin URL, the store URL with or without scheme,
 * a trailing slash or path, and the newer `admin.shopify.com/store/<handle>`.
 */

const MYSHOPIFY = ".myshopify.com";

/** `<handle>.myshopify.com`, or null when nothing usable was typed. */
export function normalizeShopDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");

  // admin.shopify.com/store/<handle> — the URL the new admin shows.
  const adminMatch = value.match(/^admin\.shopify\.com\/store\/([^/?#]+)/);
  if (adminMatch) value = `${adminMatch[1]}${MYSHOPIFY}`;

  // Drop any path, query or fragment: ".../admin", "/admin/products", "/".
  value = value.split(/[/?#]/)[0] ?? "";
  if (!value) return null;

  // A bare handle gets the suffix; anything already carrying a dot is taken as
  // a domain and validated below.
  if (!value.includes(".")) value = `${value}${MYSHOPIFY}`;

  if (!value.endsWith(MYSHOPIFY)) return null;
  const handle = value.slice(0, -MYSHOPIFY.length);
  // Shopify handles are letters, digits and hyphens; anything else is a typo we
  // should catch here rather than bounce off the install route.
  return /^[a-z0-9][a-z0-9-]*$/.test(handle) ? value : null;
}

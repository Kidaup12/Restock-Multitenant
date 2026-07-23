/**
 * Shopify id normalization. Product identity is the NUMERIC CORE of the gid:
 * "gid://shopify/Product/123" and a bare "123" are the same product. Mixing the
 * two spellings in stored rows is how duplicate-product bugs are born, so the
 * rule here is single-direction: every id is reduced to its core BEFORE it is
 * stored or used as a map key, and the database only ever holds cores.
 */

const GID_RE = /^gid:\/\/shopify\/\w+\/(\d+)/;

/** "gid://shopify/Product/123" → "123"; bare "123" passes through. */
export function numericCore(raw: string): string {
  const match = GID_RE.exec(raw);
  return match ? match[1]! : raw;
}

/** Build a gid from a core, for queries that require the gid spelling. */
export function toGid(kind: "Product" | "ProductVariant" | "Location" | "InventoryItem", core: string): string {
  return core.startsWith("gid://") ? core : `gid://shopify/${kind}/${core}`;
}

// Flat-config local plugin: fast CI tripwire for un-scoped queries on the
// RLS-bypass service client. `prismaForTenant` clients are confined by RLS at
// the database, so only `prismaService` (BYPASSRLS) can cross tenants.
// Covers reads, aggregates and the bulk writes — an un-scoped `deleteMany`
// destroys another tenant's rows rather than merely reading them — and flags
// any call whose inline `where` literal lacks a `tenantId` key. Bare
// `prismaService.tenant` single-row lookups are banned outright. Known limit:
// it cannot follow variables, so a `where` built elsewhere reads as un-scoped
// (take the inline disable and say why). The RLS isolation suite is the real
// net. A tripwire, not a proof.

// Methods whose first argument carries a `where` filter that must name the
// tenant. `groupBy` also takes `by`, and `updateMany`/`deleteMany` write —
// the `where` requirement is identical for all of them.
const WHERE_SCOPED_METHODS = new Set([
  "findMany",
  "findFirst",
  "findUnique",
  "findFirstOrThrow",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

// Single-row lookups on the tenant table itself: banned outright, filtering or
// not, because resolving a tenant is the sanctioned resolver's job.
const SINGLE_ROW_LOOKUPS = new Set([
  "findFirst",
  "findUnique",
  "findFirstOrThrow",
  "findUniqueOrThrow",
]);

/** Does this object literal name `key` directly, or one level down inside a
 *  nested object/array value? The nesting allows Prisma's compound unique
 *  keys (`where: { tenantId_sku: { tenantId, sku } }`) and `AND: [{ tenantId }]`
 *  without opening the door to arbitrarily deep, unreadable filters. */
function namesKey(objectExpression, key, depth = 1) {
  if (objectExpression?.type !== "ObjectExpression") return false;
  return objectExpression.properties.some((p) => {
    if (p.type !== "Property") return false;
    if (p.key?.name === key || p.key?.value === key) return true;
    if (depth === 0) return false;
    if (p.value?.type === "ObjectExpression") return namesKey(p.value, key, depth - 1);
    if (p.value?.type === "ArrayExpression") {
      return p.value.elements.some((el) => namesKey(el, key, depth - 1));
    }
    return false;
  });
}

function propertyValue(objectExpression, key) {
  if (objectExpression?.type !== "ObjectExpression") return undefined;
  return objectExpression.properties.find(
    (p) => p.type === "Property" && p.key?.name === key,
  )?.value;
}

/** Local names bound to the service client, so an aliased import
 *  (`import { prismaService as db }`) can't slip past the identifier check. */
function serviceClientNames(sourceCode) {
  const names = new Set(["prismaService"]);
  for (const statement of sourceCode.ast.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const spec of statement.specifiers) {
      if (spec.type === "ImportSpecifier" && spec.imported?.name === "prismaService") {
        names.add(spec.local.name);
      }
    }
  }
  return names;
}

// The two files that construct and export the clients. They are the definition
// of `prismaService`, not a consumer of it, so "did this query name a tenant?"
// is not a question that applies to them. Exempted here rather than in each
// workspace's config so the exemption travels with the rule.
const CLIENT_DEFINITION_FILES = ["packages/db/src/client.ts", "packages/db/src/index.ts"];

const rule = {
  meta: {
    type: "problem",
    docs: { description: "Service-client Prisma queries must be tenant-scoped" },
    schema: [],
  },
  create(context) {
    const filename = (context.filename ?? "").replace(/\\/g, "/");
    if (CLIENT_DEFINITION_FILES.some((f) => filename.endsWith(f))) return {};

    const clients = serviceClientNames(context.sourceCode ?? context.getSourceCode());

    return {
      "CallExpression[callee.type='MemberExpression']"(node) {
        const method = node.callee.property?.name;
        if (!WHERE_SCOPED_METHODS.has(method) && method !== "upsert") return;

        // is it <serviceClient>.<model>.<method>?
        const obj = node.callee.object;
        if (obj?.type !== "MemberExpression") return;
        const root = obj.object;
        if (root?.type !== "Identifier" || !clients.has(root.name)) return;
        const model = obj.property?.name;
        const arg = node.arguments[0];

        // Ban any bare tenant single-row lookup outright (the landmine) —
        // tenant resolution belongs in the sanctioned resolver.
        if (model === "tenant" && SINGLE_ROW_LOOKUPS.has(method)) {
          context.report({
            node,
            message:
              "Resolve tenants through the sanctioned resolver — bare prismaService.tenant lookup is banned.",
          });
          return;
        }

        // On the tenant table the scope column is its own `id`; everywhere else
        // it is `tenantId`.
        const scopeKey = model === "tenant" ? "id" : "tenantId";
        const report = () =>
          context.report({
            node,
            message: `prismaService.${model}.${method}() must filter by ${scopeKey}.`,
          });

        if (method === "upsert") {
          // upsert takes where/create/update: the row it may create must carry
          // the tenant just as much as the row it looks up.
          const where = propertyValue(arg, "where");
          const create = propertyValue(arg, "create");
          if (!namesKey(where, scopeKey)) {
            report();
            return;
          }
          if (!namesKey(create, scopeKey) && !namesKey(create, "tenant")) {
            context.report({
              node,
              message: `prismaService.${model}.upsert() must set ${scopeKey} on the created row.`,
            });
          }
          return;
        }

        if (!namesKey(propertyValue(arg, "where"), scopeKey)) report();
      },
    };
  },
};

export default { rules: { "require-tenant-scope": rule } };

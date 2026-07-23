// Flat-config local plugin: fast CI tripwire for un-scoped reads on the
// RLS-bypass service client. `prismaForTenant` clients are confined by RLS at
// the database, so only `prismaService` (BYPASSRLS) can leak across tenants.
// Bans bare prismaService.tenant.findFirst/findUnique outright, and
// prismaService.<model>.findMany/findFirst/findUnique whose inline `where`
// literal lacks a `tenantId` key. Known limit: it cannot follow variables —
// the RLS isolation suite is the real net. A tripwire, not a proof.
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Service-client Prisma reads must be tenant-scoped" },
    schema: [],
  },
  create(context) {
    return {
      "CallExpression[callee.type='MemberExpression']"(node) {
        const prop = node.callee.property?.name;
        if (!["findMany", "findFirst", "findUnique"].includes(prop)) return;

        // is it prismaService.<model>.<method>?
        const obj = node.callee.object;
        if (obj?.type !== "MemberExpression") return;
        const root = obj.object;
        if (root?.type !== "Identifier" || root.name !== "prismaService") return;
        const model = obj.property?.name;

        // Ban any prismaService.tenant.findFirst/findUnique outright (the
        // landmine) — tenant resolution belongs in the sanctioned resolver.
        if (model === "tenant" && (prop === "findFirst" || prop === "findUnique")) {
          context.report({
            node,
            message:
              "Resolve tenants through the sanctioned resolver — bare prismaService.tenant lookup is banned.",
          });
          return;
        }

        // For other models: require an inline where with tenantId.
        const arg = node.arguments[0];
        const where = arg?.properties?.find((p) => p.key?.name === "where");
        const hasTenantId = where?.value?.properties?.some(
          (p) => p.key?.name === "tenantId"
        );
        if (!hasTenantId) {
          context.report({
            node,
            message: `prismaService.${model}.${prop}() must filter by tenantId.`,
          });
        }
      },
    };
  },
};

export default { rules: { "require-tenant-scope": rule } };

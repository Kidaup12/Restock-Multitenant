import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import costVisibility from "../eslint-rules/cost-visibility.mjs";

/** RuleTester proof for the cost-gate tripwire: fires when an exported getter
 *  pulls a cost column out of the database without a `canViewCosts` flag in its
 *  signature, and stays quiet when the flag is there, when the selected column
 *  is a sales figure, and when the function is private to its module. */

// The plugin is plain JS, so its rule object is inferred structurally: TS sees
// `meta.type: string` where RuleTester wants the narrower union.
const rule = costVisibility.rules["require-cost-gate"] as Parameters<RuleTester["run"]>[1];
const tester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: "module" },
});

describe("cost-visibility/require-cost-gate", () => {
  it("fires on an exported getter selecting a cost column with no gate", () => {
    tester.run("require-cost-gate", rule, {
      valid: [],
      invalid: [
        {
          code: `
            export async function getThing(tenantId: string) {
              return db.product.findMany({
                where: { tenantId },
                select: { id: true, costKes: true },
              });
            }
          `,
          errors: [
            {
              message:
                "getThing() selects the cost column `costKes` but takes no `canViewCosts` — a money-blind member would receive it. Gate and redact, or disable with a reason.",
            },
          ],
        },
        {
          // The gate has to be this function's own parameter. A local variable
          // of the same name is not something a caller can set.
          code: `
            export async function getPo(tenantId: string) {
              const canViewCosts = true;
              return db.poLine.findMany({
                where: { tenantId },
                select: { unitCostKes: true },
              });
            }
          `,
          errors: [{ messageId: "ungatedCost" }],
        },
        {
          // The exemption above is for server actions specifically. A module
          // that merely mentions the string is not one.
          code: `
            const mode = "use server";
            export async function getThing(tenantId: string) {
              return db.product.findMany({ where: { tenantId }, select: { costKes: true } });
            }
          `,
          errors: [{ messageId: "ungatedCost" }],
        },
        {
          // Arrow-function exports are the same surface as a declaration.
          code: `
            export const getMoved = async (tenantId: string) =>
              db.product.findMany({ where: { tenantId }, select: { costMovedPct: true } });
          `,
          errors: [{ messageId: "ungatedCost" }],
        },
      ],
    });
  });

  it("stays quiet on gated getters, sales columns, and private helpers", () => {
    tester.run("require-cost-gate", rule, {
      valid: [
        // The gate, as the codebase writes it: a destructured options object.
        `
          export async function getThing(
            tenantId: string,
            { canViewCosts }: { canViewCosts: boolean },
          ) {
            const rows = await db.product.findMany({
              where: { tenantId },
              select: { costKes: true },
            });
            return rows.map((r) => ({ costKes: canViewCosts ? r.costKes : null }));
          }
        `,
        // A positional flag counts too.
        `
          export async function getThing(tenantId: string, canViewCosts: boolean) {
            return db.product.findMany({ where: { tenantId }, select: { costKes: true } });
          }
        `,
        // Selling price and revenue are sales figures — every role sees them.
        `
          export async function getThing(tenantId: string) {
            return db.product.findMany({
              where: { tenantId },
              select: { priceKes: true, revenueKes: true },
            });
          }
        `,
        // Not exported: a helper is gated by whichever getter calls it, and the
        // rule has no way to know which. Narrow beats noisy.
        `
          async function loadCosts(tenantId: string) {
            return db.product.findMany({ where: { tenantId }, select: { costKes: true } });
          }
        `,
        // A cost column mentioned outside a `select` is not a database read of
        // one — the rule only claims to see the select.
        `
          export function label(row: { costKes: number }) {
            return row.costKes > 0 ? "priced" : "missing";
          }
        `,
        // A server action checks the actor's permissions itself. Its caller is
        // the browser, so a `canViewCosts` parameter would be the reader
        // granting themselves the gate — demanding one would be demanding a
        // hole.
        `
          "use server";
          export async function setCostAction(input: { productId: string }) {
            const ctx = await actorContext(["view_costs", "manage_settings"]);
            if (!ctx) return err("no access");
            return db.product.findFirst({
              where: { id: input.productId },
              select: { costKes: true },
            });
          }
        `,
        // Excluded from a select rather than pulled by one.
        `
          export async function getThing(tenantId: string) {
            return db.product.findMany({ where: { tenantId }, select: { costKes: false } });
          }
        `,
      ],
      invalid: [],
    });
  });
});

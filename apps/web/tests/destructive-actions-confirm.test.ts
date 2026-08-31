import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every destructive action asks before it acts.
 *
 * Not a style preference: these actions drop tokens, cursors, saved selections
 * and people's access, and several are not recoverable from inside the app. A
 * Shopify disconnect throws away every sync cursor; removing app credentials
 * throws away a secret that only the Partner dashboard can reissue.
 *
 * The check is deliberately coarse — a screen that calls one of these names must
 * also pull in `useConfirm`. It cannot prove the dialog guards the right button,
 * so it is a floor, not a ceiling: it catches the case that keeps happening,
 * which is a new destructive action shipped with no dialog at all.
 *
 * A confirmation hand-rolled from component state would pass a stricter reading
 * of "asks first" and fail this one. That is intended. One pattern means one
 * place to fix the focus trap and the escape key, and the bespoke two-step this
 * replaced had neither.
 */

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".next", "tests"]);

/** Server actions and routes that destroy something a person would miss. Add to
 *  this list when you add one — that is the point of the list. */
const DESTRUCTIVE = [
  "cancelPoAction",
  "cancelTeamInvite",
  "clearShopifyAppCredentials",
  "deleteCategoryAction",
  "deleteScope",
  "deleteSupplierAction",
  "deleteWorkspaceAction",
  "removeClosureDay",
  "removeFromQueueAction",
  "removeMember",
  "removeShopifyStore",
  "removePromo",
  "revokePlatformAdminAction",
  "/api/shopify/disconnect",
  "/api/quickbooks/disconnect",
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return SKIP.has(entry) ? [] : sources(full);
    return /\.tsx$/.test(entry) ? [full] : [];
  });
}

describe("destructive actions", () => {
  const files = sources(path.join(webRoot, "app"));

  it("finds the screens at all (guards the walker)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every screen that calls one also renders a confirmation", () => {
    const offenders = files
      .map((f) => ({ file: f, text: readFileSync(f, "utf8") }))
      .filter(({ text }) => DESTRUCTIVE.some((name) => text.includes(name)))
      .filter(({ text }) => !text.includes("useConfirm"))
      .map(({ file }) => path.relative(webRoot, file));

    expect(
      offenders,
      `these call a destructive action with no confirmation — use useConfirm():\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every name on the list is still called somewhere", () => {
    // A renamed action would otherwise leave a dead entry here, and the guard
    // would quietly stop covering it.
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const dead = DESTRUCTIVE.filter((name) => !all.includes(name));
    expect(dead, `no screen calls these any more — rename or remove them here:\n${dead.join("\n")}`).toEqual([]);
  });
});

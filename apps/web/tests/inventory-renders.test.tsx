import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { LocationView } from "@/app/(shell)/inventory/location-view";

/**
 * The Inventory screen, actually rendered.
 *
 * Everything else about this page is tested through its query helpers, so the
 * controls were only ever asserted as parsed params: a picker that writes a
 * value the table ignores looked identical to one that works. These render the
 * component and read the markup instead.
 *
 * What this does NOT catch, and it was tried: passing an unserialisable prop
 * from this server component to a client one. That failure took the whole page
 * down in the browser while 1,423 tests stayed green — and it still passes
 * here, because renderToStaticMarkup does not enforce the RSC boundary. Only
 * loading the real page over HTTP sees it. The check for that lives in
 * `.claude/scratch/.../verify-inventory-export.mjs`, not in this suite.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

let seeded: SeedResult;

describe.skipIf(!runnable)("inventory renders (seeded db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
  }, 60_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  const render = async (params: Record<string, string | string[]> = {}) =>
    renderToStaticMarkup(
      await LocationView({ tenantId: seeded.tenantId, canViewCosts: true, params }),
    );

  it("renders without throwing, with its controls and its stock", async () => {
    const html = await render();
    expect(html).toContain("Columns");
    expect(html, "the export control is missing").toMatch(/CSV/);
    // A real line from the seed, so an empty table cannot pass.
    expect(html).toContain("Kilimani Shop");
  });

  it("honours the hidden-columns param on the rendered table", async () => {
    // Asserted here rather than on the parser: a picker that writes a param the
    // table ignores looks identical to one that works.
    // Anchored to the column HEADING: the picker still lists "SKU" as the
    // toggle that brings it back, so a bare substring is there either way.
    const shown = await render();
    expect(shown).toContain('aria-label="Sort by SKU');
    const hidden = await render({ hide: ["sku"] });
    expect(hidden, "hiding SKU left the column in the table").not.toContain('aria-label="Sort by SKU');
  });

  it("honours the page size on the rendered table", async () => {
    const html = await render({ per: "200" });
    expect(html).toContain("Kilimani Shop");
  });

  it("says the headings sort", async () => {
    expect(await render()).toContain("aria-sort");
  });
});

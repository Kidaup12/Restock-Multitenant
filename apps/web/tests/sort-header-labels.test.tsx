import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SortableHead, Table, TableHeader } from "@/components/ui/table";

/**
 * What a sort heading announces, against what it does.
 *
 * The label used to be computed from whether the column was ALREADY ascending,
 * while the link's direction came from a separate expression. On every column
 * that opens high-to-low — most of them, because nobody opens a stock screen
 * wanting the LEAST stock first — the two disagreed, and the announcement was
 * the exact opposite of the action. Both tables carried their own copy of the
 * bug.
 *
 * Asserted against the rendered href rather than the component's inputs: the
 * defect was two expressions drifting, so checking one of them proves nothing.
 */

type Key = "title" | "onHand" | "cover";

const render = (over: Partial<Parameters<typeof SortableHead<Key>>[0]> = {}) =>
  renderToStaticMarkup(
    <Table>
      <TableHeader>
        <SortableHead<Key>
          label="On hand"
          sortKey="onHand"
          activeKey="title"
          desc={false}
          hrefFor={(k, d) => `/x?sort=${k}&dir=${d ? "desc" : "asc"}`}
          {...over}
        />
      </TableHeader>
    </Table>,
  );

/** The direction the link actually goes, and the one it announces. */
function pair(html: string) {
  const href = /href="[^"]*dir=(asc|desc)"/.exec(html)?.[1];
  const said = /aria-label="Sort by [^,]+, (ascending|descending)"/.exec(html)?.[1];
  return { href, said };
}

describe("sort headings", () => {
  it("announces descending when it will sort descending", () => {
    // The case that was wrong: an inactive numeric column, which opens
    // high-to-low and used to announce "ascending".
    const { href, said } = pair(render());
    expect(href).toBe("desc");
    expect(said, "an inactive high-to-low column announces the wrong direction").toBe("descending");
  });

  it("announces ascending on a column that opens low-to-high", () => {
    const { href, said } = pair(render({ startAsc: true }));
    expect(href).toBe("asc");
    expect(said).toBe("ascending");
  });

  it("flips both together on the column already sorted", () => {
    const asc = pair(render({ activeKey: "onHand", desc: false }));
    expect(asc.href).toBe("desc");
    expect(asc.said).toBe("descending");

    const desc = pair(render({ activeKey: "onHand", desc: true }));
    expect(desc.href).toBe("asc");
    expect(desc.said).toBe("ascending");
  });

  it("exposes the current sort to assistive tech, not just the arrow", () => {
    // The arrow is aria-hidden, so without this the table's order is invisible
    // to anyone not looking at it.
    expect(render({ activeKey: "onHand", desc: true })).toContain('aria-sort="descending"');
    expect(render({ activeKey: "onHand", desc: false })).toContain('aria-sort="ascending"');
    // "none" means sortable-but-not-sorted; a column that does not sort at all
    // carries no aria-sort, which is a different claim.
    expect(render()).toContain('aria-sort="none"');
  });
});

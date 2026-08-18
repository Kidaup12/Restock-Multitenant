import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";

/**
 * A caller that wants a control shorter than its size offers must be able to say
 * so, and the shared components have to let it through.
 *
 * The controls set a MINIMUM height rather than a fixed one, so they can grow
 * around wrapped content. That has a sharp edge: `min-h-8` and `h-6` are
 * different utility groups, so passing `h-6` leaves BOTH on the element and the
 * minimum wins — the override looks right in the source, changes nothing on
 * screen, and neither the compiler nor the linter says a word.
 *
 * Seven call sites were silently enlarged that way when the sizes moved from
 * fixed to minimum heights: three buttons in table rows and four inline inputs.
 * These tests pin the working form and demonstrate the broken one.
 */

const classesOf = (html: string) => html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];

describe("a caller can override a control's height", () => {
  it("Button takes a smaller minimum", () => {
    const cls = classesOf(
      renderToStaticMarkup(<Button size="sm" className="min-h-6" />)
    );
    expect(cls).toContain("min-h-6");
    expect(cls, "the component's own minimum must be replaced, not sit alongside").not.toContain(
      "min-h-8"
    );
  });

  it("Input takes a smaller minimum", () => {
    const cls = classesOf(renderToStaticMarkup(<Input className="min-h-9" />));
    expect(cls).toContain("min-h-9");
    expect(cls).not.toContain("min-h-10");
  });

  it("Select takes a smaller minimum", () => {
    const html = renderToStaticMarkup(<Select className="min-h-8" />);
    const cls = html.match(/<select[^>]*class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    expect(cls).toContain("min-h-8");
    expect(cls).not.toContain("min-h-10");
  });

  // The trap itself, asserted so the reason for `min-h-*` is on the record: a
  // plain height does NOT win, because it is a different utility group.
  it("a plain height does not override the minimum — this is why callers use min-h", () => {
    // The one place the losing form is written on purpose. The lint rule that
    // now bans it everywhere else is itself proved by this line: unwire the
    // rule and `reportUnusedDisableDirectives` turns this disable into an error.
    // eslint-disable-next-line control-class-override/no-losing-height -- asserting the trap
    const cls = classesOf(renderToStaticMarkup(<Button size="sm" className="h-6" />));
    expect(cls).toContain("h-6");
    expect(
      cls,
      "both survive, so the minimum still decides the rendered height"
    ).toContain("min-h-8");
  });
});

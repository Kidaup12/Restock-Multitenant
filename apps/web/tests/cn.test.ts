import { describe, expect, it } from "vitest";
import { cn } from "@/lib/cn";

/**
 * `cn` used to concatenate, so a component's default and a caller's override
 * both reached the DOM and the winner came down to the order Tailwind emitted
 * them in the stylesheet. An override read correctly in the source, did nothing
 * on screen, and gave no clue why — `CardContent className="p-0 py-2"` around a
 * table kept the card's `p-5`, so tables were double-padded.
 */

describe("cn", () => {
  it("lets a caller's utility replace the component's default", () => {
    // The real pair from CardContent + the catalogue table.
    expect(cn("p-5", "p-0 py-2")).toBe("p-0 py-2");
    // The real pair from Input + the compact category field.
    expect(cn("h-10 w-full rounded-md", "h-8 text-sm")).toBe("w-full rounded-md h-8 text-sm");
    expect(cn("rounded-sm", "rounded-md")).toBe("rounded-md");
  });

  it("keeps everything that does not conflict", () => {
    expect(cn("flex items-center", "gap-2")).toBe("flex items-center gap-2");
    // Different axes are not conflicts: py- does not cancel px-.
    expect(cn("px-4", "py-2")).toBe("px-4 py-2");
  });

  it("still drops the falsy branches conditionals produce", () => {
    expect(cn("base", false, null, undefined, "extra")).toBe("base extra");
    expect(cn()).toBe("");
  });

  it("last wins, so the order a caller writes is the order that applies", () => {
    expect(cn("text-ink", "text-warning")).toBe("text-warning");
    expect(cn("text-warning", "text-ink")).toBe("text-ink");
  });
});

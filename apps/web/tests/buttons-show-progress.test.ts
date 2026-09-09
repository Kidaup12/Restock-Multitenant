import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A button that starts work says so, and no button does nothing.
 *
 * `Button` has carried a `loading` prop for months — it disables itself, sets
 * `aria-busy`, keeps its label's box so the width does not jump, and draws a
 * spinner. Nothing asserted that a button which submits actually passes it, so
 * three server-action forms in the admin console had no pending feedback at
 * all: press Enter workspace, see nothing change, press it again. One of them
 * writes an audit row per press.
 *
 * The two halves checked here are the ones a static read can honestly judge:
 *
 * 1. **Every submit button reports progress**, either with `loading` or by
 *    being the shared `SubmitButton` (which reads `useFormStatus` — the only
 *    thing that works inside a server component's `<form action={…}>`).
 * 2. **No button is inert** — no handler, not a submit, not a link. That one is
 *    a whole class of defect: a control that looks pressable and is not.
 *
 * What it deliberately does not judge is whether a client `onClick` that awaits
 * a server action wraps itself in a transition. Whether a given handler blocks
 * is not visible in the tag, and a test that guessed would either miss the real
 * cases or cry wolf on the dozens of buttons that only open a panel. Those are
 * covered by using the app.
 */

const WEB = path.join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * The opening tag beginning at `i`, brace- and string-aware.
 *
 * A plain `<Button[^>]*?>` stops at the first `>` it meets, which inside a
 * handler is the one in `=>`. Two earlier attempts at this scan reported
 * false positives for exactly that reason, so the tag is walked rather than
 * matched.
 */
function openingTag(src: string, i: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (quote) {
      if (c === quote && src[j - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

type Site = { where: string; tag: string };

function buttonSites(): Site[] {
  const files = [...walk(path.join(WEB, "app")), ...walk(path.join(WEB, "components"))];
  const sites: Site[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/<Button(?=[\s/>])/g)) {
      const tag = openingTag(src, m.index!);
      if (!tag) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const rel = path.relative(WEB, file).split(path.sep).join("/");
      sites.push({ where: `${rel}:${line}`, tag });
    }
  }
  return sites;
}

/**
 * Submit buttons that report nothing, each with the reason it is allowed to.
 * Both are filter forms that navigate — the page transition is the feedback,
 * and a spinner on a search box would be noise.
 */
const NO_PROGRESS_NEEDED: Record<string, string> = {
  "app/admin/audit/page.tsx": "audit filter — a GET form that navigates; the page change is the feedback",
  "app/(shell)/suppliers/[id]/products/product-picker.tsx":
    "product search — a GET form that navigates; the results are the feedback",
};

describe("buttons report their own progress", () => {
  const sites = buttonSites();

  it("found the app's buttons at all", () => {
    // Without this the tag walker could return nothing and every assertion
    // below would pass over an empty list — which is how a scan like this
    // usually goes quietly dead.
    expect(sites.length, "the button scan found almost nothing — it is broken").toBeGreaterThan(80);
  });

  it("parses a tag past the arrow in a handler", () => {
    // The bug this scan has shipped with twice, pinned as a case.
    const tag = openingTag(`<Button onClick={() => go()} loading={busy}>x</Button>`, 0);
    expect(tag, "the tag was truncated at the arrow, so loading= was never seen").toContain(
      "loading={busy}"
    );
  });

  it("every submit button shows that it is working", () => {
    const bare = sites.filter(({ where, tag }) => {
      if (!/type="submit"/.test(tag)) return false;
      if (/loading=/.test(tag)) return false;
      return !Object.keys(NO_PROGRESS_NEEDED).some((f) => where.startsWith(f));
    });
    expect(
      bare.map((s) => s.where),
      "these submit buttons start work and show nothing — pass loading, or use SubmitButton for a server-action form"
    ).toEqual([]);
  });

  it("no button is inert", () => {
    const dead = sites.filter(
      ({ tag }) =>
        !/onClick=|type="submit"|formAction=/.test(tag) && !/asChild|href=/.test(tag)
    );
    expect(
      dead.map((s) => s.where),
      "these buttons have no handler, no submit and no link — pressing them does nothing"
    ).toEqual([]);
  });

  it("allows nothing without a reason", () => {
    for (const [file, reason] of Object.entries(NO_PROGRESS_NEEDED)) {
      expect(reason.length, `${file} is exempt with no reason given`).toBeGreaterThan(25);
      expect(
        sites.some((s) => s.where.startsWith(file)),
        `${file} is exempt but has no Button any more — drop the entry`
      ).toBe(true);
    }
  });
});

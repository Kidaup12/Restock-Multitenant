// Flat-config local plugin: a tripwire for an override that reads correctly and
// does nothing. `Button`, `Input` and `Select` set a MINIMUM height so they can
// grow around wrapped content. `twMerge` resolves conflicts within a utility
// group, and `min-h-*` and `h-*` are different groups — so a caller passing
// `h-8` leaves BOTH classes on the element and the minimum still decides the
// rendered height.
//
// Nothing else catches it. The source reads as though the control is shorter,
// the types are fine, the linter was silent, and on 2026-08-17 seven call sites
// grew to full size with the whole battery green over them. Three more were
// still wrong a day later, on screens the manual sweep had not reached — which
// is the argument for a rule rather than another sweep.
//
// It is NOT a general "wrong class" check. It fires on one shape: a literal
// `className` on one of the named components, carrying a bare height. A class
// assembled by `cn()`, a variable, or a template is invisible to it, and a
// component that starts setting a minimum without being named below is not
// covered. The fix is always the same — say `min-h-*`, not `h-*`.

/** Components whose base sets `min-h-*`, so a caller's `h-*` cannot win.
 *  Kept in step with the `size` maps in components/ui/{button,select}.tsx and
 *  the base string in components/ui/input.tsx. */
const MIN_HEIGHT_CONTROLS = new Set(["Button", "Input", "Select"]);

/** A bare Tailwind height: `h-8`, `h-3.5`, `h-[34px]` — but not `min-h-8`,
 *  `max-h-72`, and not a responsive or state variant, which sit in their own
 *  group and are a deliberate choice when they appear. */
const BARE_HEIGHT = /(?:^|\s)(h-(?:\d[\d.]*|\[[^\]]+\]))(?:\s|$)/;

const plugin = {
  rules: {
    "no-losing-height": {
      meta: {
        type: "problem",
        docs: {
          description:
            "a height override on a control that sets a minimum height must use min-h-*",
        },
        schema: [],
        messages: {
          losing:
            "`{{cls}}` on <{{name}}> does nothing: the component sets a minimum height and " +
            "twMerge keeps both classes, so the minimum wins. Use `min-{{cls}}` instead.",
        },
      },
      create(context) {
        return {
          JSXAttribute(node) {
            if (node.name?.name !== "className") return;
            if (node.value?.type !== "Literal" || typeof node.value.value !== "string") return;

            const opening = node.parent;
            const name = opening?.name?.name;
            if (!MIN_HEIGHT_CONTROLS.has(name)) return;

            const found = BARE_HEIGHT.exec(node.value.value);
            if (!found) return;

            context.report({
              node,
              messageId: "losing",
              data: { cls: found[1], name },
            });
          },
        };
      },
    },
  },
};

export default plugin;

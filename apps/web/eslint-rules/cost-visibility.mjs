// Flat-config local plugin: a tripwire for the money-blindness guarantee, the
// half of the isolation story that has no database behind it. Tenant isolation
// is enforced by RLS whatever the code does; cost-blindness is enforced only by
// an author remembering to thread `canViewCosts` through a getter and null the
// figures on the way out. Nothing catches the getter that forgets.
//
// The shape it catches is deliberately one shape: an EXPORTED function that
// pulls a cost column straight out of the database — a `select: { costKes: true }`
// or equivalent — while its own signature offers the caller no way to say the
// reader is money-blind. Such a function cannot be redacting, because it does
// not know who is asking. That is a fact about its signature, not a guess about
// its behaviour, which is why it can be an error rather than a warning.
//
// It is NOT a proof of money-blindness. It cannot see a cost that arrives via a
// helper, a raw query, or a value derived from one (a rank, a partition, a
// percentage — the routes redaction has actually leaked through here before).
// The member-visibility suite is the real net; this is the thing that fires in
// CI the day someone adds a screen and forgets the suite exists.

// Columns that carry, or directly disclose, what the shop PAYS. `priceKes` and
// `revenueKes` are deliberately absent: a selling price and the sales it made
// are visible to every role by design, and listing them here would make the
// rule fire on the majority of getters — a rule that cries wolf gets switched
// off, and then it guards nothing.
//
// Kept in step with `lib/cost/surfaces.ts` (which the manifest suite
// reads) by a test that compares the two lists; if a cost column is added to
// the schema, both must learn about it.
export const COST_COLUMNS = new Set([
  "costKes",
  "lastSyncedCostKes",
  "unitCostKes",
  "lineTotalKes",
  "subtotalKes",
  // Not figures, but each answers a question about cost — where it came from,
  // whether it exists, whether it moved and by how much. The catalogue turned
  // one of these into a filter chip, which named the affected products without
  // ever printing a number.
  "costSource",
  "costUpdatedAt",
  "costMovedPct",
  "costMovedAt",
]);

/** The parameter name that lets a caller say "this reader is money-blind".
 *  A getter without it in its own signature has no way to redact. */
const GATE = "canViewCosts";

/** Walk every child node under `node`, in the order they appear, ignoring the
 *  `parent` back-reference that would otherwise send the walk upwards. Does not
 *  descend into nested function bodies — those are separate surfaces, and a
 *  callback's select belongs to whichever function declares it. */
function walk(node, visit, root = true) {
  if (!node || typeof node.type !== "string") return;
  if (!root && FUNCTION_TYPES.has(node.type)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === "string") walk(item, visit, false);
    } else if (value && typeof value.type === "string") {
      walk(value, visit, false);
    }
  }
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function keyName(property) {
  return property.key?.name ?? property.key?.value;
}

/** Cost columns named by a Prisma `select` (or `omit`-free `include` shape) at
 *  the top level of its object literal, with a truthy value. `costKes: false`
 *  is an exclusion, not a read. Depth is one level, matching how the getters in
 *  this codebase are written; a select nested inside a relation include is out
 *  of reach and stated as such above. */
function selectedCostColumns(objectExpression) {
  if (objectExpression?.type !== "ObjectExpression") return [];
  return objectExpression.properties
    .filter((p) => p.type === "Property" && COST_COLUMNS.has(keyName(p)))
    .filter((p) => !(p.value?.type === "Literal" && p.value.value === false))
    .map((p) => keyName(p));
}

/** Does this function's own parameter list offer the gate? Read off the
 *  parameter source text so every way the codebase writes it counts: a
 *  positional `canViewCosts: boolean`, a destructured `{ canViewCosts }`, or an
 *  options type that declares it. A local variable of the same name does not —
 *  the caller is the one who has to be able to say it. */
function hasGateParam(fn, sourceCode) {
  return fn.params.some((param) => new RegExp(`\\b${GATE}\\b`).test(sourceCode.getText(param)));
}

/** The name to put in the message: a declaration's own name, or the variable an
 *  exported arrow function was assigned to. */
function functionName(fn) {
  if (fn.id?.name) return fn.id.name;
  const parent = fn.parent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name;
  }
  if (parent?.type === "Property") return keyName(parent) ?? "this function";
  return "this function";
}

/** Is this whole module a server-action file? The directive has to be the first
 *  statement for React to honour it, so that is where it is looked for. */
function isUseServerFile(sourceCode) {
  const [first] = sourceCode.ast.body;
  return (
    first?.type === "ExpressionStatement" &&
    first.expression?.type === "Literal" &&
    first.expression.value === "use server"
  );
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Exported getters that select a cost column must take a canViewCosts gate",
    },
    messages: {
      ungatedCost:
        "{{name}}() selects the cost column `{{column}}` but takes no `canViewCosts` — a money-blind member would receive it. Gate and redact, or disable with a reason.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    // Server actions are exempt, and not as a convenience: a `"use server"`
    // export is called from the browser, so a `canViewCosts` parameter would be
    // set by the caller being gated. Demanding one here would be demanding a
    // hole. These files resolve the actor from the session and check
    // permissions themselves, which is the stronger gate; the rule has nothing
    // to add and would only fire on every future cost-editing action until
    // somebody switched it off.
    if (isUseServerFile(sourceCode)) return {};

    /** Exported functions only. A private helper is gated by whichever getter
     *  calls it, and the rule cannot tell which — flagging it would be the
     *  false positive that gets the rule disabled. */
    function isExported(fn) {
      let node = fn.parent;
      // const getThing = async () => …  /  export const getThing = …
      while (node && (node.type === "VariableDeclarator" || node.type === "VariableDeclaration")) {
        node = node.parent;
      }
      return (
        node?.type === "ExportNamedDeclaration" || node?.type === "ExportDefaultDeclaration"
      );
    }

    function check(fn) {
      if (!isExported(fn)) return;
      if (hasGateParam(fn, sourceCode)) return;

      let reported = false;
      walk(fn.body ?? fn, (node) => {
        if (reported) return;
        if (node.type !== "Property") return;
        if (keyName(node) !== "select") return;
        const [column] = selectedCostColumns(node.value);
        if (!column) return;
        reported = true;
        context.report({
          node,
          messageId: "ungatedCost",
          data: { name: functionName(fn), column },
        });
      });
    }

    return {
      FunctionDeclaration: check,
      ArrowFunctionExpression: check,
      FunctionExpression: check,
    };
  },
};

const plugin = { rules: { "require-cost-gate": rule } };

export default plugin;

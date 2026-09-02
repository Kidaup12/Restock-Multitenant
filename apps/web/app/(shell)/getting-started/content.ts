/**
 * How the product works, in the order a shop owner needs to hear it.
 *
 * Written as data rather than markup so the page stays a layout and the words
 * stay reviewable in one place — this is the copy a non-technical owner reads
 * to decide whether to trust a buy list, and it will be edited far more often
 * than the page around it.
 *
 * The order is deliberate: what happens without them, what they do once, what
 * they keep doing. Leading with the ongoing habit makes the product sound like
 * work; leading with what is automatic is both true and the reason to adopt it.
 */

export type Stage = {
  key: string;
  step: number;
  title: string;
  aside: string;
  intro: string;
  points: string[];
};

export const STAGES: Stage[] = [
  {
    key: "automatic",
    step: 1,
    title: "Automatic — nothing to do",
    aside: "Hands-off",
    intro: "These keep themselves current once your shop is connected:",
    points: [
      "Sales for every product, every day",
      "Stock on hand, refreshed on each sync",
      "Selling prices and your product list",
      "New products are picked up as you add them to the shop",
      "A history of stock levels — your shop does not keep one, so we build it from every sync, and the dates you ran out fall out of it",
    ],
  },
  {
    key: "once",
    step: 2,
    title: "Set up once",
    aside: "A couple of hours",
    intro:
      "Done once, usually while your workspace is being set up. The buy list gets sharper with each of these, and it says so on screen when one is missing:",
    points: [
      "A cost for each product — the buy maths needs it, and a product without one is left off the list rather than guessed at",
      "A stock count on your best sellers, so the starting numbers are real",
      "A category per product — group them the way you actually buy, and set a cover target per category if you want one",
      "Pack sizes and minimum order quantities for the products you reorder most",
      "How long each supplier takes to deliver",
      "Who can sign in, and what each person may see",
    ],
  },
  {
    key: "ongoing",
    step: 3,
    title: "Ongoing — deliberately tiny",
    aside: "Seconds, now and then",
    intro:
      "The habit that keeps the recommendations honest is small on purpose. If it were not, it would not get done:",
    points: [
      "Mark items as ordered from the buy list — you are placing the order anyway",
      "Mark an order received when the stock arrives",
      "Add a promotion to the calendar when you plan one, so the spike is expected rather than learnt",
      "Set the cost and category on a new product as you add it",
      "Update a lead time when shipping changes — rare",
    ],
  },
];

/**
 * The arithmetic, stated plainly.
 *
 * Shown because a recommendation nobody can check is a recommendation nobody
 * follows. This is the same shape the engine computes; the per-line reasoning
 * on the buy list is where the actual numbers for a product appear.
 */
export const FORMULA = "how fast it sells × how long the supplier takes + a safety margin − what you have − what is already on order";

export const FORMULA_NOTES = [
  "The selling rate leans on recent weeks rather than the whole year, and days when the product was out of stock are left out — an empty shelf sells nothing, and counting those days would read as a product going quiet.",
  "The safety margin grows when a supplier's delivery times vary. A supplier who is reliably slow needs less cushion than one who is unpredictable.",
  "Every line on the buy list shows its own working, so you can see why a number is what it is before you order against it.",
];

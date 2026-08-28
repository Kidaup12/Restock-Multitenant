# The engine's decision policy (professional rulebook)

This is the standing set of rules the engine applies to **every** client to turn
raw sales into a defensible per-SKU decision — what to do with the item, which
model to forecast it with, how confident to be, and what was assumed where data
was missing. It is not tuned to any one client.

The rules live in **`config/policy.yaml`** (tunable data, not code) and are applied
by **`src/audit_engine/decisions.py`**. Every decision the engine emits cites the
rule that fired and lists any assumption it made — so a number is never a black box.

## Precedence — the order rules are applied

Conflicts are resolved top-down. The first rule that applies wins.

1. **Data sufficiency** — is there enough to decide at all?
2. **Lifecycle** — is it dead, newborn, or active?
3. **Intermittency** — does it sell steadily or in bursts?
4. **Value × steadiness** — how much attention and what stance?
5. **Model auto-pick** — rules assign a model; the backtest may override on a clear, gated margin.

---

## 1. Enough data? (the gate before any decision)

| Question | Threshold (policy) | If not met → |
|---|---|---|
| Forecastable at all? | ≥ 13 usable weeks | Borrow a **cluster/category analog**, mark low confidence |
| Can the backtest pick a model? | ≥ 49 usable weeks | Use the **rule-default model**, flag "unvalidated" |
| Fully validated selection? | ≥ 65 usable weeks | Run the nested selection with a measured winner's-curse gap |
| Classifiable? | ≥ 4 non-zero weeks | Route on lifecycle only (can't trust ADI/CV²) |

**Assumption when missing:** thin-history SKUs default to a cluster analog (a similar
item's behaviour), *not* silence — but tagged so you know it's borrowed.

## 2. Money — can findings be priced?

| Rule | Threshold | Assumption when missing |
|---|---|---|
| Prices usable? | ≥ 80% of lines priced | Below that → **units-only, no money figures** (flagged) |
| Per-SKU price | — | Fill from the SKU's own median price, else the global median |

## 3. Promotions — clean event tagging

- **Preferred:** a supplied promo calendar.
- **Assumption when missing (the common case):** derive promos from **price drops ≥ 15%**
  below the trailing modal price. Recorded as "no calendar supplied; promos inferred
  from price."
- Promo weeks are **excluded from the baseline** so a sale never inflates "normal."

## 4. Classification — the professional axes

Every SKU is placed on three axes (all already computed by the engine):

- **ABC (value):** A ≤ 80% of cumulative revenue, B ≤ 95%, else C. *How much it's worth.*
- **XYZ (steadiness):** X steady (CV < 0.5), Y variable, Z erratic (CV ≥ 1.0). *How hard to forecast.*
- **Lifecycle:** new (first sale < 8w), active, dormant (no sale ≥ 8w). *Which way it's moving.*
- **Intermittent flag:** ADI ≥ 1.32 → routed as intermittent regardless of value.

**Assumption when missing:** no category column → SKUs are clustered by demand
correlation so pooling still works.

## 5. Action routing — what to actually do

| SKU profile | Action | Stance |
|---|---|---|
| Dormant | Run down / write-off | none |
| New (< 8w) | Launch curve, watch weekly | launch |
| Intermittent/erratic **and A-class** | Reorder point + safety stock (buffer) | rule |
| Intermittent/erratic, B or C | Pool by category + reorder rule | rule |
| A, steady (X) | Forecast + human review | forecast |
| A, variable (Y) | Forecast + heavy safety stock | forecast |
| B, steady (X) | Forecast on autopilot | forecast |
| Everything else (C steady …) | Pool + reorder rule | rule |

The professional principle encoded here: **A gets forecasting effort, B gets pooling
and rules, the tail gets a write-off decision — and even within A, only the steady
ones are truly forecast; the erratic ones are buffered.**

## 6. Model auto-pick — rules first, backtest breaks ties

The engine does **not** just crown the lowest-error model. It starts from a
professional default per segment, and only lets the backtest override on evidence:

**Rule defaults (per segment):**

| Segment | Default model | Why |
|---|---|---|
| Intermittent | **M9 (TSB)** | Decays dead items to zero |
| Seasonal, 104w+ | M10 (ETS) | Real seasonality, two seasons of data |
| Steady A | M7 (Theta) | Trend-aware, high-value worth the effort |
| Steady B | M5 (median) | Robust, low-effort |
| Erratic / default | M5 | Safe presumed champion |
| New | Cluster analog | No own history yet |
| Dormant | none | Don't forecast the dead |

**Override rule — the backtest challenger replaces the rule default only if ALL hold:**

- beats the rule default by **≥ 10% relative WAPE**, *and*
- its **|bias| ≤ 20%** (won't systematically under/over-stock), *and*
- it **beats the naive floor**, *and*
- the gain **holds on the validation block** (not just the selection block).

Otherwise the rule default stands, and the reason says so: *"backtest challenger X
did not clear the override margin."* This is what stops the engine from chasing a
model that got lucky on noisy history — the winner's-curse guard, applied as policy.

**Combinations** ship only if their members are diverse (residual correlation < 0.90);
intermittent SKUs are never combined.

## 7. Confidence — how sure is the call?

| Level | When |
|---|---|
| **High** | Validated-backtest model choice + ≥ 65w history + censoring under 25% |
| **Medium** | Rule-default model, or inner-only (unvalidated) selection |
| **Low** | Cluster analog / thin history / heavy censoring |
| **Provisional** | *Always*, until a daily stock snapshot de-censors the history |

Every decision is provisional in v1 by design — because the sales history is
censored (a stockout looks like low demand). The confidence level tells you how far
to trust it; the provisional flag reminds everyone the real fix is the stock snapshot.

---

## The output

For each SKU the engine emits: **action, model, stance, confidence, a plain-language
reason** (which rule fired), and the **assumptions** made where data was missing. Plus
a catalogue-level summary and the full list of distinct assumptions. That is the
"engine that decides, and explains why" — professional rules, applied consistently,
honest about what it couldn't see.

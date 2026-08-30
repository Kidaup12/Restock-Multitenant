"""Synthetic retail sales generator with planted faults (SPEC §15).

Everything is deterministic per (scenario, seed): one numpy Generator seeded
once drives every draw. Demand is Poisson at SKU-specific daily rates:

- smooth SKUs: constant lambda_daily in [1, 8]
- intermittent SKUs: lambda_weekly set from a target ADI of 2-4 weeks
  (sell roughly every 2-4 weeks, ADI >= 1.32)
- seasonal SKUs: annual sinusoid, amplitude 0.4-0.6

Fault scenarios plant the SPEC §15 fault table via synth.faults; pure
model-process scenarios (proc_*) generate known processes for harness
acceptance (SPEC §15 selection-harness table). Ground truth is assembled by
synth.truth, including truth['true_rate'] — the uncensored weekly demand
rate lambda per sku/week (the rate BEFORE stockout censoring).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from audit_engine.config import Config
from audit_engine.schemas import StockSchema, TxSchema
from audit_engine.synth import faults
from audit_engine.synth.truth import (
    LOCATION,
    apply_renames_to_true_rate,
    empty_truth,
    true_rate_table,
)

START_DATE = pd.Timestamp("2024-01-01")  # a Monday — config.time.week_start

# Which fault families each fault scenario plants.
FAULT_PLAN: dict[str, frozenset[str]] = {
    "full": frozenset(
        {
            "stockouts",
            "closures",
            "promos",
            "spikes",
            "level_shifts",
            "bulk_orders",
            "renames",
            "returns",
        }
    ),
    "clean": frozenset(),
    "stockouts_only": frozenset({"stockouts"}),
    "closures": frozenset({"closures"}),
    "promos": frozenset({"promos"}),
    # 'intermittent': pure intermittent catalogue, no faults — false-positive /
    # not-assessable-routing test bed.
    "intermittent": frozenset(),
}

PROC_SCENARIOS = (
    "proc_stable",
    "proc_trend",
    "proc_seasonal",
    "proc_intermittent",
    "proc_dying",
    "proc_noise",
)

SCENARIOS = tuple(FAULT_PLAN) + PROC_SCENARIOS

TX_COLUMNS = [
    "date",
    "sku",
    "location",
    "qty",
    "unit_price",
    "order_id",
    "customer_type",
    "line_type",
]


@dataclass
class SynthResult:
    sales: pd.DataFrame  # transaction-level, TxSchema-compatible
    stock: pd.DataFrame  # current on-hand, StockSchema-compatible
    truth: dict[str, pd.DataFrame]
    scenario: str = "full"
    seed: int = 42

    def write_csvs(self, out_dir) -> dict[str, Path]:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        paths: dict[str, Path] = {
            "sales": out / "sales.csv",
            "stock": out / "stock.csv",
        }
        self.sales.to_csv(paths["sales"], index=False)
        self.stock.to_csv(paths["stock"], index=False)
        for key, df in self.truth.items():
            path = out / f"truth_{key}.csv"
            df.to_csv(path, index=False)
            paths[f"truth_{key}"] = path
        return paths


# --------------------------------------------------------------------------
# catalogue
# --------------------------------------------------------------------------


def _lambda_weekly_from_adi(adi: float) -> float:
    """lambda_weekly such that P(non-zero week) = 1/adi under Poisson."""
    return float(-np.log(1.0 - 1.0 / adi))


def _sku_params(kind: str, rng: np.random.Generator) -> dict:
    if kind in ("smooth", "proc_stable"):
        return {"lam_daily": float(rng.uniform(1.0, 8.0))}
    if kind == "intermittent":
        # sell roughly every 2-4 weeks -> ADI 2-4 >= 1.32
        return {"lam_daily": _lambda_weekly_from_adi(float(rng.uniform(2.0, 4.0))) / 7.0}
    if kind == "proc_intermittent":
        # ADI ~= 3.0 with small jitter
        return {"lam_daily": _lambda_weekly_from_adi(3.0 * float(rng.uniform(0.95, 1.05))) / 7.0}
    if kind == "seasonal":
        return {
            "lam_daily": float(rng.uniform(1.5, 8.0)),
            "amp": float(rng.uniform(0.4, 0.6)),
            "phase": float(rng.uniform(0.0, 365.0)),
        }
    if kind == "proc_seasonal":
        return {
            "lam_daily": float(rng.uniform(2.0, 8.0)),
            "amp": float(rng.uniform(0.6, 0.8)),
            "phase": float(rng.uniform(0.0, 365.0)),
        }
    if kind == "proc_trend":
        return {"lam_daily": float(rng.uniform(1.0, 4.0)), "end_mult": float(rng.uniform(2.0, 3.0))}
    if kind == "proc_dying":
        return {"lam_daily": float(rng.uniform(2.0, 6.0))}
    if kind == "proc_noise":
        mu = float(rng.uniform(20.0, 60.0))
        return {"lam_daily": mu / 7.0, "mu_weekly": mu, "sigma_weekly": 0.3 * mu}
    raise ValueError(f"unknown sku kind: {kind}")


def _catalogue(
    scenario: str,
    rng: np.random.Generator,
    n_smooth: int,
    n_intermittent: int,
    n_seasonal: int,
) -> pd.DataFrame:
    rows: list[dict] = []

    def add(prefix: str, count: int, kind: str) -> None:
        for j in range(count):
            row = {"sku": f"{prefix}{j + 1:03d}", "kind": kind}
            row.update(_sku_params(kind, rng))
            row["price"] = round(float(rng.uniform(6.0, 60.0)), 2)
            rows.append(row)

    if scenario in PROC_SCENARIOS:
        count = {
            "proc_intermittent": n_intermittent,
            "proc_seasonal": n_seasonal,
        }.get(scenario, n_smooth)
        add("P", count, scenario)
    elif scenario == "intermittent":
        add("IN", n_intermittent, "intermittent")
    else:
        add("SM", n_smooth, "smooth")
        add("IN", n_intermittent, "intermittent")
        add("SE", n_seasonal, "seasonal")
    if not rows:
        raise ValueError("catalogue is empty: all SKU counts are zero")
    cat = pd.DataFrame(rows).reset_index(drop=True)
    for col in ("amp", "phase", "end_mult", "mu_weekly", "sigma_weekly"):
        if col not in cat.columns:
            cat[col] = np.nan
    return cat


# --------------------------------------------------------------------------
# demand processes
# --------------------------------------------------------------------------


def _lam_matrix(cat: pd.DataFrame, n_days: int) -> np.ndarray:
    """Uncensored daily demand rate per (sku, day)."""
    t = np.arange(n_days, dtype=float)
    lam = np.zeros((len(cat), n_days), dtype=float)
    for i in range(len(cat)):
        kind = cat["kind"].iat[i]
        base = float(cat["lam_daily"].iat[i])
        if kind in ("seasonal", "proc_seasonal"):
            amp = float(cat["amp"].iat[i])
            phase = float(cat["phase"].iat[i])
            lam[i] = base * (1.0 + amp * np.sin(2.0 * np.pi * (t + phase) / 365.25))
        elif kind == "proc_trend":
            end_mult = float(cat["end_mult"].iat[i])
            lam[i] = base * (1.0 + (end_mult - 1.0) * t / max(1.0, n_days - 1.0))
        elif kind == "proc_dying":
            # constant, then linear decay over the last ~26 weeks reaching
            # exactly zero for the final 4 weeks.
            zero_day = max(1, n_days - 28)
            decay_start = max(0, n_days - 26 * 7)
            span = max(1, zero_day - decay_start)
            mult = np.clip((zero_day - t) / span, 0.0, 1.0)
            lam[i] = base * mult
        else:
            # smooth / intermittent / proc_stable / proc_intermittent /
            # proc_noise (mu/7 so weekly true rate == mu)
            lam[i] = base
    return np.maximum(lam, 0.0)


def _draw_units(
    scenario: str, lam: np.ndarray, cat: pd.DataFrame, n_weeks: int, rng: np.random.Generator
) -> np.ndarray:
    """Integer units sold per (sku, day) — before censoring faults."""
    if scenario != "proc_noise":
        return rng.poisson(lam)
    # white noise around a weekly mean, spread uniformly across the week
    n_sku, n_days = lam.shape
    mu = cat["mu_weekly"].to_numpy(dtype=float)
    sigma = cat["sigma_weekly"].to_numpy(dtype=float)
    weekly = np.clip(
        np.round(rng.normal(mu[:, None], sigma[:, None], size=(n_sku, n_weeks))), 0, None
    ).astype(np.int64)
    units = np.zeros((n_sku, n_days), dtype=np.int64)
    seventh = np.full(7, 1.0 / 7.0)
    for i in range(n_sku):
        for w in range(n_weeks):
            if weekly[i, w] > 0:
                units[i, w * 7 : (w + 1) * 7] = rng.multinomial(int(weekly[i, w]), seventh)
    return units


# --------------------------------------------------------------------------
# transaction building
# --------------------------------------------------------------------------


def _build_tx(
    units: np.ndarray,
    cat: pd.DataFrame,
    dates: pd.DatetimeIndex,
    price_mat: np.ndarray,
    rng: np.random.Generator,
) -> pd.DataFrame:
    """Split daily units into 1-4 order lines with realistic prices.

    Unit price is fixed per SKU; ~10% of non-promo lines get a small 5%
    discount so the modal price stays exactly at the SKU base price (which
    keeps the planted promo drop >= threshold below the mode, detectable).
    """
    sku_idx, day_idx = np.nonzero(units)
    if sku_idx.size == 0:
        return pd.DataFrame({c: pd.Series(dtype=t) for c, t in zip(
            TX_COLUMNS,
            ["datetime64[ns]", object, object, float, float, object, object, object],
        )})
    u = units[sku_idx, day_idx].astype(np.int64)
    n_lines_per_cell = np.minimum(u, rng.integers(1, 5, size=u.size))
    total = int(n_lines_per_cell.sum())
    reps = np.repeat(np.arange(u.size), n_lines_per_cell)
    starts = np.cumsum(n_lines_per_cell) - n_lines_per_cell
    pos_in_cell = np.arange(total) - np.repeat(starts, n_lines_per_cell)
    qty = (u // n_lines_per_cell)[reps] + (pos_in_cell < (u % n_lines_per_cell)[reps])

    line_sku = sku_idx[reps]
    line_day = day_idx[reps]
    line_week = line_day // 7
    base_price = cat["price"].to_numpy(dtype=float)
    price = price_mat[line_sku, line_week].copy()
    is_promo = price < base_price[line_sku] - 1e-9
    small_disc = (rng.random(total) < 0.10) & ~is_promo
    price[small_disc] = np.round(price[small_disc] * 0.95, 2)

    skus = cat["sku"].to_numpy(dtype=object)
    tx = pd.DataFrame(
        {
            "date": dates.to_numpy()[line_day],
            "sku": skus[line_sku],
            "location": LOCATION,
            "qty": qty.astype(float),
            "unit_price": np.round(price, 2),
            "order_id": [f"O{j:08d}" for j in range(total)],
            "customer_type": "retail",
            "line_type": "sale",
        }
    )
    return tx


def _build_stock(
    cat: pd.DataFrame,
    lam_weekly: np.ndarray,
    rename_map: dict[str, str],
    rng: np.random.Generator,
) -> pd.DataFrame:
    """Current on-hand export: 0-20 weeks of cover, ~8% of SKUs at zero."""
    mean_weekly = lam_weekly.mean(axis=1)
    cover = rng.uniform(0.0, 20.0, size=len(cat))
    qty = np.round(mean_weekly * cover)
    qty[rng.random(len(cat)) < 0.08] = 0.0
    stock = pd.DataFrame(
        {
            "sku": [rename_map.get(s, s) for s in cat["sku"]],
            "location": LOCATION,
            "qty_on_hand": qty.astype(float),
            "unit_cost": np.round(cat["price"].to_numpy(dtype=float) * 0.5, 2),
        }
    )
    return stock


# --------------------------------------------------------------------------
# fault SKU pools
# --------------------------------------------------------------------------


def _fault_pools(cat: pd.DataFrame) -> dict[str, list]:
    """Disjoint smooth-SKU pools per fault family, highest lambda first.

    Stockout SKUs need lambda >= 3/day (SPEC §15 acceptance band); the rest
    take the next-highest-rate SKUs so planted effects are well identified.
    """
    smooth = [i for i in range(len(cat)) if cat["kind"].iat[i] == "smooth"]
    order = sorted(smooth, key=lambda i: -float(cat["lam_daily"].iat[i]))
    eligible = [i for i in order if float(cat["lam_daily"].iat[i]) >= 3.0]
    stockouts = eligible[:8]
    rest = [i for i in order if i not in stockouts]
    return {
        "stockouts": stockouts,
        "promos": rest[:4],
        "spikes": rest[4:7],
        "level_shifts": rest[7:10],
        "renames": rest[10:12],
        "bulk_orders": rest[12:16],
        "returns": [cat["sku"].iat[i] for i in rest[16:]],
    }


# --------------------------------------------------------------------------
# main entry point
# --------------------------------------------------------------------------


def generate(
    scenario: str = "full",
    seed: int = 42,
    n_weeks: int = 104,
    n_smooth: int = 60,
    n_intermittent: int = 60,
    n_seasonal: int = 20,
    config: Config | None = None,
) -> SynthResult:
    """Generate a synthetic catalogue with known ground truth.

    Deterministic per (scenario, seed): a single ``numpy.random.default_rng``
    seeded once drives every draw.
    """
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario {scenario!r}; expected one of {sorted(SCENARIOS)}")
    cfg = config if config is not None else Config()
    rng = np.random.default_rng(seed)

    n_days = n_weeks * 7
    dates = pd.date_range(START_DATE, periods=n_days, freq="D")
    week_starts = pd.DatetimeIndex(dates[::7])

    cat = _catalogue(scenario, rng, n_smooth, n_intermittent, n_seasonal)
    lam = _lam_matrix(cat, n_days)

    plan = FAULT_PLAN.get(scenario, frozenset())
    pools = _fault_pools(cat) if plan else {}
    truth = empty_truth()

    # per (sku, week) unit price — base price unless a promo drops it
    price_mat = np.repeat(cat["price"].to_numpy(dtype=float)[:, None], n_weeks, axis=1)

    # 1. demand-level faults (mutate lambda BEFORE the draw)
    if "promos" in plan:
        truth["promos"] = faults.plant_promos(
            lam, price_mat, cat, week_starts, pools.get("promos", []), rng, cfg
        )
    if "spikes" in plan:
        truth["spikes"] = faults.plant_spikes(lam, cat, week_starts, pools.get("spikes", []), rng)
    if "level_shifts" in plan:
        truth["level_shifts"] = faults.plant_level_shifts(
            lam, cat, week_starts, pools.get("level_shifts", []), rng
        )

    # uncensored true weekly rate — after demand faults, before censoring
    lam_weekly = lam.reshape(len(cat), n_weeks, 7).sum(axis=2)

    # 2. draw units, then censoring faults (zero sales AFTER the draw)
    units = _draw_units(scenario, lam, cat, n_weeks, rng)
    closure_days: set[int] = set()
    if "closures" in plan:
        truth["closures"], closure_days = faults.plant_closures(units, dates, rng)
    if "stockouts" in plan:
        truth["stockouts"] = faults.plant_stockouts(
            units, lam, cat, dates, pools.get("stockouts", []), rng, blocked_days=closure_days
        )

    # 3. build transactions, then transaction-level faults
    tx = _build_tx(units, cat, dates, price_mat, rng)
    extra_frames: list[pd.DataFrame] = []
    if "bulk_orders" in plan:
        bulk_rows, truth["bulk_orders"] = faults.plant_bulk_orders(
            tx, cat, pools.get("bulk_orders", []), dates, rng, cfg, blocked_days=closure_days
        )
        if not bulk_rows.empty:
            extra_frames.append(bulk_rows)
    if "returns" in plan:
        blocked_dates = {dates[d] for d in closure_days}
        return_rows, truth["returns"] = faults.plant_returns(
            tx, pools.get("returns", []), dates, rng, blocked_dates=blocked_dates
        )
        if not return_rows.empty:
            extra_frames.append(return_rows)
    if extra_frames:
        tx = pd.concat([tx, *extra_frames], ignore_index=True)
    rename_map: dict[str, str] = {}
    if "renames" in plan:
        truth["renames"], rename_map = faults.plant_renames(
            tx, cat, week_starts, pools.get("renames", []), rng
        )

    # 4. truth true_rate (uncensored), relabelled for renames
    true_rate = true_rate_table(list(cat["sku"]), week_starts, lam_weekly)
    if rename_map:
        true_rate = apply_renames_to_true_rate(true_rate, truth["renames"])
    truth["true_rate"] = true_rate

    # 5. current stock export (today's labels — post-rename)
    stock = _build_stock(cat, lam_weekly, rename_map, rng)

    sales = (
        tx.sort_values(["date", "sku", "order_id"], kind="mergesort")
        .reset_index(drop=True)[TX_COLUMNS]
    )
    sales = TxSchema.validate(sales)
    stock = StockSchema.validate(stock)
    return SynthResult(sales=sales, stock=stock, truth=truth, scenario=scenario, seed=seed)

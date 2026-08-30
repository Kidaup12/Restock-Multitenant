"""Unit tests for the selection harness (agent-select).

Uses tiny stub BatchModel subclasses only — never the concrete models from
audit_engine.models.* (built by another agent in parallel). PanelMatrices are
constructed by hand from small numpy arrays.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from audit_engine.config import Config
from audit_engine.models.base import BatchModel, FutureLeakError, insufficient_history, masked_history
from audit_engine.panel import PanelMatrices
from audit_engine.selection.harness import plan_origins, run_backtest
from audit_engine.selection.nested import run_nested
from audit_engine.selection.routing import (
    pick_champions, selection_gap, strategy_scores, winner_stability,
)
from audit_engine.selection.scoring import pct_vs_floor, score_frame, signed_bias_pct, wape
from audit_engine.selection.smoke import horizon_monotonicity, shuffle_test


# --------------------------------------------------------------------------
# stub models
# --------------------------------------------------------------------------

class ConstantModel(BatchModel):
    """Predicts a fixed value for every series and horizon."""
    min_history_weeks = 1

    def __init__(self, value: float, model_id: str = "CONST", handles_intermittent: bool = False):
        super().__init__()
        self.value = float(value)
        self.model_id = model_id
        self.handles_intermittent = handles_intermittent

    def _fit(self, Y_prefix, usable_prefix, origin_idx):
        self._insuf = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)

    def _predict(self, horizons):
        out = np.full((len(self._insuf), len(horizons)), self.value, dtype=float)
        out[self._insuf] = np.nan
        return out


class HighMinHistoryModel(ConstantModel):
    """Constant model that never has enough history -> always predicts NaN."""
    min_history_weeks = 999


class LastValueModel(BatchModel):
    """Predicts the last usable observed value (naive floor stand-in)."""
    min_history_weeks = 1

    def __init__(self, model_id: str = "LAST"):
        super().__init__()
        self.model_id = model_id

    def _fit(self, Y_prefix, usable_prefix, origin_idx):
        hist = masked_history(Y_prefix, usable_prefix)
        n, T = hist.shape
        last = np.full(n, np.nan)
        for i in range(n):
            valid = np.nonzero(np.isfinite(hist[i]))[0]
            if len(valid):
                last[i] = hist[i, valid[-1]]
        self._last = last

    def _predict(self, horizons):
        return np.tile(self._last[:, None], (1, len(horizons)))


class PerfectModel(BatchModel):
    """Oracle that memorized the full truth matrix at construction time.

    Scores WAPE 0 on the real panel; must collapse under the shuffle test."""
    min_history_weeks = 1

    def __init__(self, Y_full: np.ndarray, model_id: str = "PERFECT"):
        super().__init__()
        self._Y = np.asarray(Y_full, dtype=float)
        self.model_id = model_id

    def _fit(self, Y_prefix, usable_prefix, origin_idx):
        pass  # origin stored by the base class

    def _predict(self, horizons):
        n, T = self._Y.shape
        cols = []
        for h in horizons:
            t = self._origin_idx + h - 1
            cols.append(self._Y[:, t] if t < T else np.full(n, np.nan))
        return np.column_stack(cols)


class LeakyModel(BatchModel):
    """Tries to read the last column of whatever it is given (the future, if
    the caller hands it more than the prefix). The base-class guard must fire
    before _fit ever runs when the widths disagree."""
    min_history_weeks = 1

    def __init__(self, model_id: str = "LEAKY"):
        super().__init__()
        self.model_id = model_id

    def _fit(self, Y_prefix, usable_prefix, origin_idx):
        self._stolen = Y_prefix[:, -1]

    def _predict(self, horizons):
        return np.tile(self._stolen[:, None], (1, len(horizons)))


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def make_mats(Y: np.ndarray, usable: np.ndarray | None = None,
              stockout: np.ndarray | None = None) -> PanelMatrices:
    Y = np.asarray(Y, dtype=float)
    n, T = Y.shape
    weeks = pd.date_range("2024-01-01", periods=T, freq="W-MON")
    return PanelMatrices(
        Y_corrected=Y,
        Y_raw=Y.copy(),
        usable_mask=np.ones((n, T), dtype=bool) if usable is None else usable.astype(bool),
        stockout_mask=np.zeros((n, T), dtype=bool) if stockout is None else stockout.astype(bool),
        promo_mask=np.zeros((n, T), dtype=bool),
        price=np.full((n, T), 10.0),
        weeks=weeks,
        series_index=pd.DataFrame({"sku": [f"S{i}" for i in range(n)], "location": ["ALL"] * n}),
    )


def make_score_rows(entries, n_origins=12, block="selection", start="2024-01-01"):
    """entries: list of (sku, model_id, y_true, y_pred); one row per origin each."""
    origins = pd.date_range(start, periods=n_origins, freq="28D")
    rows = []
    for o in origins:
        for sku, model_id, yt, yp in entries:
            rows.append({
                "block": block, "origin_date": o, "model_id": model_id,
                "sku": sku, "location": "ALL", "horizon": 1,
                "y_true": float(yt), "y_pred": float(yp),
                "scored": True, "exclusion_reason": None,
            })
    return pd.DataFrame(rows)


@pytest.fixture
def cfg() -> Config:
    return Config()


# --------------------------------------------------------------------------
# scoring basics
# --------------------------------------------------------------------------

def test_wape_and_bias_basics():
    assert wape([10, 10], [9, 11]) == pytest.approx(0.1)
    assert signed_bias_pct([10, 10], [9, 11]) == pytest.approx(0.0)
    assert signed_bias_pct([10, 10], [8, 8]) == pytest.approx(-20.0)
    # NaN pairs excluded
    assert wape([10, np.nan, 10], [9, 5, np.nan]) == pytest.approx(0.1)
    assert np.isnan(wape([np.nan], [1.0]))
    assert np.isnan(wape([0.0], [1.0]))  # zero denominator


def test_pct_vs_floor():
    scores = make_score_rows([
        ("S0", "GOOD", 10, 9),     # wape 0.1
        ("S0", "FLOOR", 10, 8),    # wape 0.2
    ], n_origins=3)
    out = pct_vs_floor(scores, "FLOOR")
    good = out.loc[out["model_id"] == "GOOD"].iloc[0]
    assert good["pct_improvement_vs_floor"] == pytest.approx(50.0)
    floor = out.loc[out["model_id"] == "FLOOR"].iloc[0]
    assert floor["pct_improvement_vs_floor"] == pytest.approx(0.0)


# --------------------------------------------------------------------------
# plan_origins: history gate tiers + exact origin arithmetic
# --------------------------------------------------------------------------

def test_plan_origins_tier_none_at_40(cfg):
    plan = plan_origins(40, cfg.selection)
    assert plan["tier"] == "none"
    assert plan["selection_origin_idx"] == []
    assert plan["validation_origin_idx"] == []


def test_plan_origins_tier_inner_only_at_55(cfg):
    plan = plan_origins(55, cfg.selection)
    assert plan["tier"] == "inner_only"
    # sel target 10 needs 13+4+40=57 > 55 -> walk down to 9 (needs 53)
    assert plan["selection_origins"] == 9
    assert plan["validation_origins"] == 0
    assert plan["selection_origin_idx"] == [19, 23, 27, 31, 35, 39, 43, 47, 51]
    assert plan["validation_origin_idx"] == []
    assert plan["weeks_needed"] == 53


def test_plan_origins_tier_nested_at_80(cfg):
    plan = plan_origins(80, cfg.selection)
    assert plan["tier"] == "nested"
    # 10 sel + 6 val needs 13+4+64=81 > 80 -> shed one validation origin -> 77
    assert plan["selection_origins"] == 10
    assert plan["validation_origins"] == 5
    assert plan["weeks_needed"] == 77
    # validation block = LAST val*step weeks; selection immediately before
    assert plan["validation_origin_idx"] == [60, 64, 68, 72, 76]
    assert plan["selection_origin_idx"] == [20, 24, 28, 32, 36, 40, 44, 48, 52, 56]
    # earliest selection origin leaves >= 13 + horizon train weeks
    assert plan["selection_origin_idx"][0] >= 13 + cfg.selection.horizon_weeks


def test_plan_origins_accepts_full_config(cfg):
    assert plan_origins(80, cfg)["tier"] == "nested"


# --------------------------------------------------------------------------
# run_backtest
# --------------------------------------------------------------------------

def test_backtest_perfect_beats_constant(cfg):
    rng = np.random.default_rng(7)
    Y = rng.uniform(5, 15, size=(2, 40))
    mats = make_mats(Y)
    plan = {"tier": "inner_only", "selection_origin_idx": [20, 24, 28],
            "validation_origin_idx": []}
    roster = lambda: {"PERFECT": PerfectModel(Y), "CONST": ConstantModel(10.0, "CONST")}
    result = run_backtest(mats, roster, cfg, origin_plan=plan)

    assert result.tier == "inner_only"
    assert result.origins == [20, 24, 28]
    scored = result.scores.loc[result.scores["scored"]]
    # 2 series x 3 origins x 4 horizons per model
    assert (scored.groupby("model_id").size() == 24).all()
    w = {m: wape(g["y_true"], g["y_pred"]) for m, g in scored.groupby("model_id")}
    assert w["PERFECT"] == pytest.approx(0.0, abs=1e-12)
    assert w["CONST"] > 0.05
    assert result.excluded_pct == 0.0


def test_backtest_censoring_unusable_and_excluded_pct(cfg):
    Y = np.full((1, 40), 10.0)
    stockout = np.zeros((1, 40), dtype=bool)
    stockout[0, 31] = True                 # censored target
    usable = np.ones((1, 40), dtype=bool)
    usable[0, 32] = False                  # unusable target
    mats = make_mats(Y, usable=usable, stockout=stockout)
    plan = {"tier": "inner_only", "selection_origin_idx": [30], "validation_origin_idx": []}
    roster = lambda: {
        "PERFECT": PerfectModel(Y),
        "CONST": ConstantModel(10.0, "CONST"),
        "NOHIST": HighMinHistoryModel(10.0, "NOHIST"),
    }
    result = run_backtest(mats, roster, cfg, origin_plan=plan)
    s = result.scores

    for m in ("PERFECT", "CONST"):
        rows = s[s["model_id"] == m].set_index("horizon")
        assert bool(rows.loc[1, "scored"]) and rows.loc[1, "exclusion_reason"] is None
        assert not rows.loc[2, "scored"] and rows.loc[2, "exclusion_reason"] == "censored"
        assert not rows.loc[3, "scored"] and rows.loc[3, "exclusion_reason"] == "unusable"
        assert bool(rows.loc[4, "scored"])
    # NaN predictions -> insufficient_history (on rows with no other exclusion)
    nohist = s[s["model_id"] == "NOHIST"].set_index("horizon")
    assert nohist.loc[1, "exclusion_reason"] == "insufficient_history"
    assert nohist.loc[4, "exclusion_reason"] == "insufficient_history"
    assert not nohist["scored"].any()

    # censored share among otherwise-scoreable rows: PERFECT+CONST contribute
    # 3 otherwise-ok rows each (h1, h2, h4), of which h2 is censored
    assert result.excluded_pct == pytest.approx(100.0 * 2 / 6)


def test_backtest_beyond_panel(cfg):
    Y = np.full((1, 40), 10.0)
    mats = make_mats(Y)
    plan = {"tier": "inner_only", "selection_origin_idx": [38], "validation_origin_idx": []}
    result = run_backtest(mats, lambda: {"CONST": ConstantModel(10.0, "CONST")}, cfg,
                          origin_plan=plan)
    rows = result.scores.set_index("horizon")
    assert bool(rows.loc[1, "scored"]) and bool(rows.loc[2, "scored"])
    assert rows.loc[3, "exclusion_reason"] == "beyond_panel"
    assert rows.loc[4, "exclusion_reason"] == "beyond_panel"
    assert np.isnan(rows.loc[3, "y_true"])


def test_future_leak_guard_fires():
    Y = np.full((2, 20), 10.0)
    usable = np.ones((2, 20), dtype=bool)
    leaky = LeakyModel()
    # constructed violation: the full matrix (width 20) with origin_idx 10
    with pytest.raises(FutureLeakError):
        leaky.fit(Y, usable, origin_idx=10)
    # the correct slice passes
    leaky.fit(Y[:, :10], usable[:, :10], origin_idx=10)
    assert leaky.predict([1, 2]).shape == (2, 2)


# --------------------------------------------------------------------------
# strategies
# --------------------------------------------------------------------------

def test_s1_beats_s0_when_segments_differ(cfg):
    # two segments with genuinely different level: one model per segment is right
    Y = np.vstack([np.full((2, 40), 10.0), np.full((2, 40), 2.0)])
    mats = make_mats(Y)
    segments = pd.DataFrame({
        "sku": ["S0", "S1", "S2", "S3"], "location": ["ALL"] * 4,
        "segment": ["AX", "AX", "BX", "BX"],
    })
    cfg.models.default_champion = "C10"
    plan = {"tier": "inner_only", "selection_origin_idx": [20, 24, 28],
            "validation_origin_idx": []}
    roster = lambda: {"C10": ConstantModel(10.0, "C10"), "C2": ConstantModel(2.0, "C2")}
    result = run_backtest(mats, roster, cfg, origin_plan=plan)

    champions = pick_champions(result.scores, segments, cfg)
    s1 = champions[champions["strategy"] == "S1"].set_index("scope_value")
    assert s1.loc["AX", "champion_model_id"] == "C10"
    assert s1.loc["BX", "champion_model_id"] == "C2"

    strat = strategy_scores(result.scores, champions, segments)
    w = {st: wape(g["y_true"], g["y_pred"]) for st, g in strat.groupby("strategy")}
    assert w["S1"] == pytest.approx(0.0, abs=1e-12)
    assert w["S0"] > 0.3          # C10 everywhere is badly wrong on the BX segment
    assert w["S1"] < w["S0"]

    gap = selection_gap(strat, strat.iloc[0:0])
    assert set(gap["strategy"]) == {"S0", "S1", "S2"}
    assert gap.set_index("strategy").loc["S1", "sel_wape"] == pytest.approx(0.0, abs=1e-12)


def test_s2_guardrails(cfg):
    # segment champion is A overall; per-SKU overrides only where guardrails pass
    scores = pd.concat([
        make_score_rows([
            ("s1", "A", 10, 9.0), ("s1", "B", 10, 7.0),     # A wape .1, B .3
            ("s2", "A", 10, 9.0), ("s2", "B", 10, 7.0),
            ("s3", "A", 10, 7.0), ("s3", "B", 10, 9.5),     # B better by 83%, stable
            ("s4", "A", 10, 9.0), ("s4", "B", 10, 9.02),    # B margin only 2% < 5%
        ], n_origins=12),
        make_score_rows([
            ("s5", "A", 10, 7.0), ("s5", "B", 10, 9.5),     # huge margin, 3 origins < 12
        ], n_origins=3),
    ], ignore_index=True)
    segments = pd.DataFrame({
        "sku": ["s1", "s2", "s3", "s4", "s5"], "location": ["ALL"] * 5,
        "segment": ["AX"] * 5,
    })
    champions = pick_champions(scores, segments, cfg)

    s1 = champions[champions["strategy"] == "S1"].set_index("scope_value")
    assert s1.loc["AX", "champion_model_id"] == "A"

    s2 = champions[champions["strategy"] == "S2"].set_index("scope_value")["champion_model_id"]
    assert s2["s3|ALL"] == "B"     # all guardrails pass -> override
    assert s2["s4|ALL"] == "A"     # margin below min_margin_pct -> fallback
    assert s2["s5|ALL"] == "A"     # too few origins -> fallback
    assert s2["s1|ALL"] == "A"
    assert s2["s2|ALL"] == "A"


def test_s1_intermittent_restriction(cfg):
    scores = make_score_rows([
        ("i1", "SMOOTH", 10, 9.9),   # best wape but cannot handle intermittency
        ("i1", "SPARSE", 10, 9.0),
    ], n_origins=6)
    segments = pd.DataFrame({"sku": ["i1"], "location": ["ALL"], "segment": ["intermittent"]})
    champs = pick_champions(scores, segments, cfg, intermittent_ok={"SPARSE"})
    s1 = champs[champs["strategy"] == "S1"].set_index("scope_value")
    assert s1.loc["intermittent", "champion_model_id"] == "SPARSE"
    # without the restriction the raw argmin wins
    champs2 = pick_champions(scores, segments, cfg, intermittent_ok=None)
    s1b = champs2[champs2["strategy"] == "S1"].set_index("scope_value")
    assert s1b.loc["intermittent", "champion_model_id"] == "SMOOTH"


def test_winner_stability_flips():
    # winner alternates every origin -> flip rate 1.0
    frames = []
    for k in range(4):
        good, bad = ("A", "B") if k % 2 == 0 else ("B", "A")
        frames.append(make_score_rows(
            [("s1", good, 10, 9.5), ("s1", bad, 10, 5.0)],
            n_origins=1, start=pd.Timestamp("2024-01-01") + pd.Timedelta(days=28 * k),
        ))
    stab = winner_stability(pd.concat(frames, ignore_index=True))
    row = stab.set_index(["sku", "location"]).loc[("s1", "ALL")]
    assert row["n_origins"] == 4
    assert row["flip_rate"] == pytest.approx(1.0)


# --------------------------------------------------------------------------
# nested: touch-once + artifacts
# --------------------------------------------------------------------------

def test_nested_run_and_touch_once(cfg, tmp_path):
    Y = np.full((2, 80), 10.0)
    mats = make_mats(Y)
    segments = pd.DataFrame({"sku": ["S0", "S1"], "location": ["ALL"] * 2,
                             "segment": ["AX", "AX"]})
    cfg.models.default_champion = "C10"
    roster = lambda: {"C10": ConstantModel(10.0, "C10"), "C5": ConstantModel(5.0, "C5")}
    run_dir = tmp_path / "run1"

    res = run_nested(mats, roster, cfg, segments, run_dir)
    assert res["tier"] == "nested"
    assert res["routing"]["segments"]["AX"]["champion"] == "C10"
    assert res["routing"]["segments"]["AX"]["val_wape"] == pytest.approx(0.0)
    assert res["routing"]["status"] == "provisional"
    gap = res["selection_gap"].set_index("strategy")
    for st in ("S0", "S1", "S2"):
        assert gap.loc[st, "gap"] == pytest.approx(0.0, abs=1e-12)
    # validation block scored champions only
    assert set(res["val_scores"]["model_id"].unique()) == {"C10"}
    for artifact in ("model_scores.parquet", "selection_gap.parquet",
                     "winner_stability.parquet", "routing_table.yaml",
                     "selection_analysis.md", "outer_touched.marker",
                     "validation_log.txt"):
        assert (run_dir / artifact).exists(), artifact

    # second touch refused
    with pytest.raises(RuntimeError, match="already scored"):
        run_nested(mats, roster, cfg, segments, run_dir)
    # force overrides, and logs the second touch
    res2 = run_nested(mats, roster, cfg, segments, run_dir, force=True)
    assert res2["tier"] == "nested"
    log = (run_dir / "validation_log.txt").read_text(encoding="utf-8")
    assert len(log.strip().splitlines()) == 2


def test_nested_tier_none_defaults(cfg, tmp_path):
    Y = np.full((2, 40), 10.0)
    mats = make_mats(Y)
    cfg.models.default_champion = "C10"
    roster = lambda: {"C10": ConstantModel(10.0, "C10")}
    res = run_nested(mats, roster, cfg, None, tmp_path / "run_none")
    assert res["tier"] == "none"
    assert res["routing"]["default_champion"] == "C10"
    assert res["routing"]["segments"] == {}
    assert (tmp_path / "run_none" / "routing_table.yaml").exists()
    assert not (tmp_path / "run_none" / "outer_touched.marker").exists()


# --------------------------------------------------------------------------
# leakage smoke tests
# --------------------------------------------------------------------------

def test_shuffle_test_degrades_perfect_model(cfg):
    rng = np.random.default_rng(11)
    Y = rng.uniform(5, 15, size=(3, 60))
    mats = make_mats(Y)
    roster = lambda: {"PERFECT": PerfectModel(Y), "CONST": ConstantModel(10.0, "CONST")}

    # sanity: on the real panel the oracle is perfect
    real = run_backtest(mats, roster, cfg)
    real_scored = real.scores.loc[real.scores["scored"]]
    real_w = {m: wape(g["y_true"], g["y_pred"]) for m, g in real_scored.groupby("model_id")}
    assert real_w["PERFECT"] == pytest.approx(0.0, abs=1e-12)

    # shuffled targets: the oracle collapses to ~naive/constant level
    table = shuffle_test(mats, roster, cfg, seed=1).set_index("model_id")
    perfect_w = float(table.loc["PERFECT", "wape"])
    const_w = float(table.loc["CONST", "wape"])
    assert perfect_w > 0.15
    assert perfect_w > 0.5 * const_w


def test_horizon_monotonicity_flags_inversion():
    rows = []
    # OK: wape .1, .15, .15, .2 across horizons (non-decreasing within tolerance)
    # INV: wape .3 at h1 then .1 at h2 (error improves with distance -> leak smell)
    spec = {"OK": {1: 9.0, 2: 8.5, 3: 8.5, 4: 8.0}, "INV": {1: 7.0, 2: 9.0}}
    for model_id, preds in spec.items():
        for h, yp in preds.items():
            rows.append({
                "block": "selection", "origin_date": pd.Timestamp("2024-01-01"),
                "model_id": model_id, "sku": "s1", "location": "ALL",
                "horizon": h, "y_true": 10.0, "y_pred": yp,
                "scored": True, "exclusion_reason": None,
            })
    out = horizon_monotonicity(pd.DataFrame(rows))
    flags = out.drop_duplicates("model_id").set_index("model_id")["monotone_nondecreasing"]
    assert bool(flags["OK"]) is True
    assert bool(flags["INV"]) is False


def test_score_frame_aggregation(cfg):
    scores = make_score_rows([
        ("S0", "GOOD", 10, 9),     # wape .1, bias -10
        ("S0", "FLOOR", 10, 12),   # wape .2, bias +20
        ("S1", "GOOD", 10, 9),
        ("S1", "FLOOR", 10, 12),
    ], n_origins=4)
    out = score_frame(scores, floor_model_id="FLOOR").set_index("model_id")
    assert out.loc["GOOD", "wape"] == pytest.approx(0.1)
    assert out.loc["GOOD", "bias_pct"] == pytest.approx(-10.0)
    assert out.loc["FLOOR", "bias_pct"] == pytest.approx(20.0)
    assert out.loc["GOOD", "n_scored"] == 8
    assert out.loc["GOOD", "pct_skus_beating_floor"] == pytest.approx(100.0)
    assert out.loc["GOOD", "wape_origin_std"] == pytest.approx(0.0)

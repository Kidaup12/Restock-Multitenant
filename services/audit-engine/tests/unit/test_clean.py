"""Unit tests for the 17-step cleaning chain (clean/*).

Small hand-built transaction frames; a stub AvailabilitySource so nothing here
imports availability/inferred.py (built in parallel).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from audit_engine.availability.base import AvailabilitySource
from audit_engine.clean import steps
from audit_engine.clean.audit_log import AuditLog
from audit_engine.clean.pipeline import CleanResult, run_chain
from audit_engine.clean.trailing import trailing_median, trailing_median_df, trailing_winsorize
from audit_engine.config import Config
from audit_engine.schemas import AuditLogSchema, PanelSchema
from audit_engine.types import LogRow

CFG = Config()
MON = pd.Timestamp("2025-01-06")  # a Monday


def wk(i: int) -> pd.Timestamp:
    return MON + pd.Timedelta(weeks=i)


def make_tx(rows: list[tuple]) -> pd.DataFrame:
    df = pd.DataFrame(
        rows,
        columns=["date", "sku", "location", "qty", "unit_price", "order_id", "customer_type", "line_type"],
    )
    df["date"] = pd.to_datetime(df["date"])
    return df


def _empty_eps() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "sku": pd.Series(dtype=str),
            "location": pd.Series(dtype=str),
            "start_date": pd.Series(dtype="datetime64[ns]"),
            "end_date": pd.Series(dtype="datetime64[ns]"),
            "days": pd.Series(dtype="int64"),
            "confidence": pd.Series(dtype=str),
            "p_value": pd.Series(dtype=float),
            "cross_sectional_share": pd.Series(dtype=float),
        }
    )


class StubAvailability(AvailabilitySource):
    """Returns fixed weekly in-stock days / episodes; ignores the daily frame."""

    def __init__(self, weekly: pd.DataFrame | None = None, episodes: pd.DataFrame | None = None):
        self._weekly = weekly
        self._episodes = episodes if episodes is not None else _empty_eps()

    def in_stock_days(self, daily, config):
        weekly = self._weekly if self._weekly is not None else pd.DataFrame(
            columns=["sku", "location", "week_start", "in_stock_days", "confidence"]
        )
        return weekly, self._episodes


# ---------------------------------------------------------------------------
# trailing.py
# ---------------------------------------------------------------------------

class TestTrailing:
    def test_trailing_median_is_past_only(self):
        out = trailing_median(np.array([1.0, 2.0, 3.0, 4.0]), window=2)
        assert np.isnan(out[0])
        assert out[1] == 1.0
        assert out[2] == 1.5
        assert out[3] == 2.5

    def test_trailing_median_nan_aware(self):
        out = trailing_median(np.array([1.0, np.nan, 3.0]), window=2)
        assert out[1] == 1.0          # NaN at t=1 does not affect its own window
        assert out[2] == 1.0          # window [1, NaN] -> median skips NaN
        out2 = trailing_median(np.array([np.nan, np.nan, 5.0]), window=2)
        assert np.isnan(out2[2]) or out2[2] != out2[2] or np.isnan(out2[1])

    def test_trailing_median_df_groups_independent(self):
        df = pd.DataFrame(
            {
                "sku": ["A", "A", "A", "B", "B"],
                "location": ["ALL"] * 5,
                "week_start": [wk(0), wk(1), wk(2), wk(0), wk(1)],
                "v": [10.0, 20.0, 30.0, 100.0, 200.0],
            }
        )
        out = trailing_median_df(df, ["sku", "location"], "v", window=13, sort_col="week_start")
        assert np.isnan(out.iloc[0])
        assert out.iloc[1] == 10.0
        assert out.iloc[2] == 15.0
        assert np.isnan(out.iloc[3])      # B's first week: no A leakage
        assert out.iloc[4] == 100.0

    def test_trailing_winsorize_caps_and_flags(self):
        vals = np.array([10.0] * 13 + [100.0])
        capped, flag = trailing_winsorize(vals, window=13, multiple=2.0)
        assert capped[-1] == 20.0
        assert flag[-1]
        assert not flag[:-1].any()

    def test_trailing_winsorize_idempotent(self):
        vals = np.array([10.0, 10.0, 50.0, 10.0, 80.0, 10.0])
        once, _ = trailing_winsorize(vals, window=3, multiple=2.0)
        twice, flag2 = trailing_winsorize(once, window=3, multiple=2.0)
        np.testing.assert_allclose(once, twice)

    def test_trailing_winsorize_skip_mask(self):
        vals = np.array([10.0] * 13 + [100.0])
        skip = np.zeros(14, dtype=bool)
        skip[13] = True
        capped, flag = trailing_winsorize(vals, window=13, multiple=2.0, skip_mask=skip)
        assert capped[13] == 100.0
        assert not flag.any()


# ---------------------------------------------------------------------------
# audit_log.py
# ---------------------------------------------------------------------------

class TestAuditLog:
    def test_roundtrip(self, tmp_path):
        log = AuditLog()
        log.extend([LogRow(2, "dedupe_exact_lines", "3 dupes"), LogRow(15, "winsorize_trailing_cap", "capped", sku="A", week="2025-01-06")])
        frame = log.to_frame()
        AuditLogSchema.validate(frame)
        assert len(frame) == 2
        assert list(frame["step_number"]) == [2, 15]
        p = tmp_path / "audit.parquet"
        log.write(p)
        back = pd.read_parquet(p)
        assert len(back) == 2

    def test_empty_log_validates(self):
        frame = AuditLog().to_frame()
        AuditLogSchema.validate(frame)
        assert len(frame) == 0


# ---------------------------------------------------------------------------
# individual steps
# ---------------------------------------------------------------------------

class TestSteps:
    def test_step02_dedupe_count(self):
        tx = make_tx(
            [
                (wk(0), "A", "ALL", 2.0, 10.0, "o1", "retail", "sale"),
                (wk(0), "A", "ALL", 2.0, 10.0, "o1", "retail", "sale"),   # exact dupe
                (wk(0), "A", "ALL", 3.0, 10.0, "o2", "retail", "sale"),
            ]
        )
        df, rows = steps.step_02_dedupe(tx, CFG)
        assert (df[steps.EXCLUDE_COL] == "duplicate").sum() == 1
        [row] = [r for r in rows if r.rule_name == "dedupe_exact_lines"]
        assert "1 exact duplicate" in row.reason

    def test_step04_excludes_staff_and_cancelled(self):
        tx = make_tx(
            [
                (wk(0), "A", "ALL", 1.0, 10.0, "o1", "staff", "sale"),
                (wk(0), "A", "ALL", 1.0, 10.0, "o2", "retail", "cancelled"),
                (wk(0), "A", "ALL", 1.0, 10.0, "o3", "retail", "sale"),
            ]
        )
        df, _ = steps.step_04_exclude_non_demand(tx, CFG)
        reasons = df[steps.EXCLUDE_COL].dropna().tolist()
        assert sorted(reasons) == ["non_demand_customer_type", "non_demand_line_type"]

    def test_step05_return_netted_to_sale_date(self):
        tx = make_tx(
            [
                (wk(0), "A", "ALL", 5.0, 10.0, "o1", "retail", "sale"),
                (wk(1) + pd.Timedelta(days=3), "A", "ALL", -2.0, 10.0, "o2", "retail", "return"),
            ]
        )
        df, rows = steps.step_05_net_returns(tx, CFG)
        # the return line moved onto the sale's date
        assert (df.loc[df["qty"] < 0, "date"] == wk(0)).all()
        assert any(r.rule_name == "return_netted_to_sale_date" for r in rows)

    def test_step05_return_outside_window_not_moved(self):
        tx = make_tx(
            [
                (wk(0), "A", "ALL", 5.0, 10.0, "o1", "retail", "sale"),
                (wk(10), "A", "ALL", -2.0, 10.0, "o2", "retail", "return"),  # 10 weeks later
            ]
        )
        df, _ = steps.step_05_net_returns(tx, CFG)
        assert (df.loc[df["qty"] < 0, "date"] == wk(10)).all()

    def test_step06_bulk_threshold(self):
        tx = make_tx(
            [(wk(i), "A", "ALL", q, 10.0, f"o{i}", "retail", "sale") for i, q in enumerate([2.0, 2.0, 2.0, 2.0, 20.0])]
        )
        df, _ = steps.step_06_flag_bulk(tx, CFG)
        # median 2, threshold 5x2=10 -> only the 20 flagged
        assert df["bulk_line_flag"].tolist() == [False, False, False, False, True]

    def test_step06_at_threshold_not_flagged(self):
        tx = make_tx(
            [(wk(i), "A", "ALL", q, 10.0, f"o{i}", "retail", "sale") for i, q in enumerate([2.0, 2.0, 10.0])]
        )
        df, _ = steps.step_06_flag_bulk(tx, CFG)
        # median 2 -> threshold 10; qty == 10 is not strictly greater
        assert not df["bulk_line_flag"].any()

    def test_step07_bundle_explode(self):
        tx = make_tx(
            [
                (wk(0), "GIFTSET", "ALL", 2.0, 30.0, "o1", "retail", "sale"),
                (wk(0), "B", "ALL", 1.0, 5.0, "o2", "retail", "sale"),
            ]
        )
        bundle_map = {"GIFTSET": [("X", 1.0), ("Y", 2.0)]}
        df, _ = steps.step_07_explode_bundles(tx, CFG, bundle_map)
        assert "GIFTSET" not in set(df["sku"])
        assert df.loc[df["sku"] == "X", "qty"].sum() == 2.0
        assert df.loc[df["sku"] == "Y", "qty"].sum() == 4.0
        assert df.loc[df["sku"] == "B", "qty"].sum() == 1.0

    def test_step09_zero_fill_only_inside_lifespan(self):
        tx = make_tx(
            [
                (wk(0), "A", "ALL", 3.0, 10.0, "o1", "retail", "sale"),
                (wk(3), "A", "ALL", 4.0, 10.0, "o2", "retail", "sale"),
            ]
        )
        res = run_chain(tx, CFG, StubAvailability())
        p = res.panel
        assert list(p["week_start"]) == [wk(0), wk(1), wk(2), wk(3)]
        assert p["filled_zero_flag"].tolist() == [False, True, True, False]
        assert p.loc[p["filled_zero_flag"], "units_raw"].eq(0).all()

    def test_step10_promo_detection_on_price_drop(self):
        rows = [(wk(i), "A", "ALL", 2.0, 10.0, f"o{i}", "retail", "sale") for i in range(6)]
        rows.append((wk(6), "A", "ALL", 2.0, 8.0, "o6", "retail", "sale"))  # 20% drop >= 15%
        res = run_chain(make_tx(rows), CFG, StubAvailability())
        p = res.panel
        assert p.loc[p["week_start"] == wk(6), "promo_flag"].all()
        assert not p.loc[p["week_start"] < wk(6), "promo_flag"].any()

    def test_step10_small_drop_not_promo(self):
        rows = [(wk(i), "A", "ALL", 2.0, 10.0, f"o{i}", "retail", "sale") for i in range(6)]
        rows.append((wk(6), "A", "ALL", 2.0, 9.0, "o6", "retail", "sale"))  # 10% drop < 15%
        res = run_chain(make_tx(rows), CFG, StubAvailability())
        assert not res.panel["promo_flag"].any()

    def test_step13_correction_and_cap(self):
        stub_weekly = pd.DataFrame(
            {
                "sku": ["A", "A", "A"],
                "location": ["ALL"] * 3,
                "week_start": [wk(0), wk(1), wk(2)],
                "in_stock_days": [2.0, 5.0, 7.0],
                "confidence": ["high", "medium", "none"],
            }
        )
        rows = [(wk(i), "A", "ALL", 10.0, 10.0, f"o{i}", "retail", "sale") for i in range(3)]
        res = run_chain(make_tx(rows), CFG, StubAvailability(weekly=stub_weekly))
        p = res.panel.set_index("week_start")
        # 10 * 7/2 = 35 -> capped at 1.5 * 10 = 15
        assert p.loc[wk(0), "units_corrected"] == pytest.approx(15.0)
        # 10 * 7/5 = 14 <= 15 -> uncapped
        assert p.loc[wk(1), "units_corrected"] == pytest.approx(14.0)
        # full week -> untouched
        assert p.loc[wk(2), "units_corrected"] == pytest.approx(10.0)

    def test_step14_min_coverage_unusable(self):
        stub_weekly = pd.DataFrame(
            {
                "sku": ["A", "A"],
                "location": ["ALL"] * 2,
                "week_start": [wk(0), wk(1)],
                "in_stock_days": [2.0, 3.0],
                "confidence": ["high", "none"],
            }
        )
        rows = [(wk(i), "A", "ALL", 5.0, 10.0, f"o{i}", "retail", "sale") for i in range(2)]
        res = run_chain(make_tx(rows), CFG, StubAvailability(weekly=stub_weekly))
        p = res.panel.set_index("week_start")
        assert not p.loc[wk(0), "usable"]        # 2 < 3
        assert p.loc[wk(1), "usable"]            # 3 >= 3

    def test_step15_winsorize_caps_and_skips_promo(self):
        n = 15
        weekly = pd.DataFrame(
            {
                "sku": ["A"] * n,
                "location": ["ALL"] * n,
                "week_start": [wk(i) for i in range(n)],
                "units_raw": [10.0] * 13 + [50.0, 50.0],
                "units_corrected": [10.0] * 13 + [50.0, 50.0],
                "promo_flag": [False] * 14 + [True],
                "bulk_flag": [False] * n,
            }
        )
        out, rows = steps.step_15_winsorize(weekly, CFG)
        out = out.set_index("week_start")
        assert out.loc[wk(13), "units_corrected"] == pytest.approx(20.0)   # capped at 2x median 10
        assert out.loc[wk(13), "winsorize_capped_flag"]
        assert out.loc[wk(14), "units_corrected"] == pytest.approx(50.0)   # promo week skipped
        assert not out.loc[wk(14), "winsorize_capped_flag"]
        assert any(r.rule_name == "winsorize_trailing_cap" and r.week == wk(13).date().isoformat() for r in rows)

    def test_step16_level_shift_uncaps(self):
        n = 14
        vals = [10.0] * 8 + [40.0] * 6
        weekly = pd.DataFrame(
            {
                "sku": ["A"] * n,
                "location": ["ALL"] * n,
                "week_start": [wk(i) for i in range(n)],
                "units_raw": vals,
                "units_corrected": vals,
                "promo_flag": [False] * n,
                "bulk_flag": [False] * n,
            }
        )
        w15, _ = steps.step_15_winsorize(weekly, CFG)
        # all six 40s capped to 20 (trailing median stays 10 in the 13w window)
        assert (w15.loc[w15["week_start"] >= wk(8), "units_corrected"] == 20.0).all()
        w16, rows = steps.step_16_level_shift(w15, CFG)
        out = w16.set_index("week_start")
        assert (out.loc[[wk(i) for i in range(8, 14)], "units_corrected"] == 40.0).all()
        assert out.loc[[wk(i) for i in range(8, 14)], "level_shift_flag"].all()
        assert not out.loc[[wk(i) for i in range(8)], "level_shift_flag"].any()
        assert not out["winsorize_capped_flag"].any()
        assert any(r.rule_name == "level_shift_detected" for r in rows)

    def test_step16_short_run_not_a_shift(self):
        n = 11
        vals = [10.0] * 8 + [40.0] * 3   # only 3 capped weeks < 4
        weekly = pd.DataFrame(
            {
                "sku": ["A"] * n,
                "location": ["ALL"] * n,
                "week_start": [wk(i) for i in range(n)],
                "units_raw": vals,
                "units_corrected": vals,
                "promo_flag": [False] * n,
                "bulk_flag": [False] * n,
            }
        )
        w15, _ = steps.step_15_winsorize(weekly, CFG)
        w16, _ = steps.step_16_level_shift(w15, CFG)
        assert not w16["level_shift_flag"].any()
        assert (w16.loc[w16["week_start"] >= wk(8), "units_corrected"] == 20.0).all()


# ---------------------------------------------------------------------------
# end-to-end pipeline
# ---------------------------------------------------------------------------

class TestRunChain:
    def _build(self):
        rows = []
        for i in range(6):
            rows.append((wk(i), "A", "ALL", 5.0, 10.0, f"o{i}", "retail", "sale"))
        rows.append((wk(1), "A", "ALL", 5.0, 10.0, "o1", "retail", "sale"))          # exact dupe of o1
        rows.append((wk(2), "A", "ALL", 1.0, 10.0, "s1", "staff", "sale"))           # staff line
        rows.append((wk(2) + pd.Timedelta(days=2), "A", "ALL", -1.0, 10.0, "r1", "retail", "return"))
        tx = make_tx(rows)
        episode = pd.DataFrame(
            {
                "sku": ["A"],
                "location": ["ALL"],
                "start_date": [wk(3) + pd.Timedelta(days=2)],
                "end_date": [wk(3) + pd.Timedelta(days=4)],
                "days": [3],
                "confidence": ["high"],
                "p_value": [1e-4],
                "cross_sectional_share": [0.1],
            }
        )
        stub_weekly = pd.DataFrame(
            {
                "sku": ["A"],
                "location": ["ALL"],
                "week_start": [wk(3)],
                "in_stock_days": [4.0],
                "confidence": ["high"],
            }
        )
        return tx, StubAvailability(weekly=stub_weekly, episodes=episode)

    def test_full_chain(self):
        tx, avail = self._build()
        res = run_chain(tx, CFG, avail)
        assert isinstance(res, CleanResult)
        p = PanelSchema.validate(res.panel).set_index("week_start")

        # dupe + staff line excluded
        assert sorted(res.excluded["reason"].tolist()) == ["duplicate", "non_demand_customer_type"]

        # return netted onto week 2's sale (week2 sale of 5 at wk(2), return at wk(2)+2d
        # moves back to wk(2)): week 2 raw = 5 - 1 = 4
        assert p.loc[wk(2), "units_raw"] == pytest.approx(4.0)

        # stockout week: flagged from episode, corrected 5 * 7/4 = 8.75 -> cap 1.5*5 = 7.5
        assert p.loc[wk(3), "stockout_flag"]
        assert p.loc[wk(3), "stockout_confidence"] == "high"
        assert p.loc[wk(3), "units_corrected"] == pytest.approx(7.5)
        assert p.loc[wk(3), "usable"]                      # 4 >= 3 in-stock days

        # other weeks untouched
        assert p.loc[wk(0), "units_corrected"] == pytest.approx(5.0)
        assert p.loc[wk(0), "stockout_confidence"] == "none"

        # episodes passed through, audit log validates and covers all 17 steps' rules
        assert len(res.episodes) == 1
        AuditLogSchema.validate(res.audit_log)
        logged_steps = set(res.audit_log["step_number"])
        assert logged_steps.issuperset({1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17})

        # daily spine complete, non-negative
        d = res.daily
        assert (d["units"] >= 0).all()
        span = pd.date_range(d["date"].min(), d["date"].max(), freq="D")
        assert len(d) == len(span)

    def test_unmatched_return_floored_at_zero(self):
        tx = make_tx(
            [
                (wk(0), "A", "ALL", 2.0, 10.0, "o1", "retail", "sale"),
                (wk(0), "B", "ALL", -4.0, 10.0, "r1", "retail", "return"),  # no prior sale of B
            ]
        )
        res = run_chain(tx, CFG, StubAvailability())
        p = res.panel.set_index("sku")
        assert p.loc["B", "units_raw"] == 0.0
        assert (res.audit_log["rule_name"] == "returns_week_floor_zero").any()

    def test_sku_mapping_merges_history(self):
        tx = make_tx(
            [
                (wk(0), "OLD", "ALL", 3.0, 10.0, "o1", "retail", "sale"),
                (wk(1), "NEW", "ALL", 4.0, 10.0, "o2", "retail", "sale"),
            ]
        )
        res = run_chain(tx, CFG, StubAvailability(), sku_mapping={"OLD": "NEW"})
        p = res.panel
        assert set(p["sku"]) == {"NEW"}
        assert p["units_raw"].sum() == pytest.approx(7.0)
        assert (res.audit_log["rule_name"] == "sku_rename").any()

    def test_bulk_week_flagged_and_reported(self):
        rows = [(wk(i), "A", "ALL", 2.0, 10.0, f"o{i}", "retail", "sale") for i in range(5)]
        rows.append((wk(2), "A", "ALL", 25.0, 10.0, "big", "retail", "sale"))
        res = run_chain(make_tx(rows), CFG, StubAvailability())
        p = res.panel.set_index("week_start")
        assert p.loc[wk(2), "bulk_flag"]
        assert not p.loc[wk(0), "bulk_flag"]
        # bulk units kept in the panel...
        assert p.loc[wk(2), "units_raw"] == pytest.approx(27.0)
        # ...and the line reported in excluded
        assert (res.excluded["reason"] == "bulk_order").sum() == 1

    def test_empty_after_exclusions(self):
        tx = make_tx([(wk(0), "A", "ALL", 1.0, 10.0, "o1", "staff", "sale")])
        res = run_chain(tx, CFG, StubAvailability())
        assert len(res.panel) == 0
        PanelSchema.validate(res.panel)
        assert len(res.excluded) == 1

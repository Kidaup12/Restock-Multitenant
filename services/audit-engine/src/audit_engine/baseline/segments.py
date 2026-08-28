"""Catalogue segmentation: ABC × XYZ, forecastability, lifecycle, routing.

All statistics are computed over the trailing 52 weeks as of the last panel
week (never full-sample beyond that trailing window).

- **ABC** — by trailing-52-week value (``units_raw × price``), ranked within
  each location; cumulative-share thresholds from
  ``config.segments.abc_thresholds``. Price per SKU is the median of the
  weekly ``price_median`` in the window, backfilled from ``price_lookup``
  (columns ``sku``, ``price``) and then the global median price. If no price
  exists anywhere, value falls back to units.
- **XYZ** — coefficient of variation (population std / mean) of weekly
  ``units_corrected`` (zeros included); thresholds
  ``config.segments.xyz_cv_thresholds``; undefined CV → 'Z'.
- **Forecastability (SPEC §7.7)** — ADI = mean interval (in weeks) between
  non-zero weeks; CV² = squared CV of the non-zero demand sizes.
  ``demand_class`` is the four-quadrant label: ADI ≥ 1.32 and CV² ≥ 0.49 →
  'intermittent'; both below → 'smooth'; ADI < 1.32, CV² ≥ 0.49 →
  'erratic'; ADI ≥ 1.32, CV² < 0.49 → 'lumpy'.
  ``intermittent_flag`` (which drives routing) is **ADI-only**:
  ADI ≥ ``config.segments.intermittent_adi``, per the SPEC §10 routing
  table's own bucket definition "Intermittent (ADI ≥ 1.32)" — sparse items
  with regular sizes (the 'lumpy' quadrant) still need intermittent-demand
  models, not ABC×XYZ routing.
  Fewer than two non-zero weeks → ADI undefined: demand_class
  'intermittent' but ``intermittent_flag`` False (cannot be established), so
  lifecycle routing (dormant/new) still applies.
- **Lifecycle** — 'new' (< 8 weeks history), 'dormant' (no sale in
  ``dormancy_weeks``), else 'active'. (The two cannot overlap: a SKU with
  < 8 weeks of history necessarily sold within the last 8 weeks.)
- **Routing segment** — 'intermittent' if ``intermittent_flag``, else
  'new'/'dormant' by lifecycle, else the ABC×XYZ cell (e.g. 'AX').
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from audit_engine.schemas import SegmentSchema

# SPEC §7.6 — ABC by trailing 52-week value. Not in defaults.yaml.
TRAILING_VALUE_WEEKS = 52
# SPEC §10 routing table: "New (< 8 weeks)". Not in defaults.yaml.
NEW_WEEKS = 8

_EPS = 1e-9  # float tolerance on exact cumulative-share boundaries


def compute_segments(
    panel: pd.DataFrame,
    config,
    price_lookup: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Compute SegmentSchema rows, one per SKU-location in the panel."""
    scfg = config.segments
    xyz_lo, xyz_hi = scfg.xyz_cv_thresholds
    abc_a, abc_b = scfg.abc_thresholds

    df = panel.loc[
        :, ["sku", "location", "week_start", "units_raw", "units_corrected", "price_median"]
    ].copy()
    df["week_start"] = pd.to_datetime(df["week_start"])
    as_of = df["week_start"].max()
    window_lo = as_of - pd.Timedelta(days=7 * TRAILING_VALUE_WEEKS)  # exclusive

    rows: list[dict] = []
    for (sku, loc), g in df.groupby(["sku", "location"], sort=True):
        gw = g[g["week_start"] > window_lo].sort_values("week_start")
        weekly = gw["units_corrected"].to_numpy(dtype=float)
        weekly = np.nan_to_num(weekly, nan=0.0)

        # XYZ: CV of weekly corrected demand, zeros included
        mean_w = weekly.mean() if weekly.size else 0.0
        cv = float(weekly.std(ddof=0) / mean_w) if weekly.size and mean_w > 0 else np.nan
        if np.isnan(cv):
            xyz = "Z"
        elif cv < xyz_lo:
            xyz = "X"
        elif cv < xyz_hi:
            xyz = "Y"
        else:
            xyz = "Z"

        # ADI / CV² on non-zero weeks (SPEC §7.7)
        week_pos = ((gw["week_start"] - gw["week_start"].min()).dt.days // 7).to_numpy() \
            if not gw.empty else np.array([], dtype=int)
        nz_mask = weekly > 0
        nz_pos = week_pos[nz_mask]
        nz_vals = weekly[nz_mask]
        adi = float(np.mean(np.diff(nz_pos))) if nz_pos.size >= 2 else np.nan
        cv2 = float((nz_vals.std(ddof=0) / nz_vals.mean()) ** 2) if nz_vals.size else np.nan

        # four-quadrant label (SPEC §7.7)
        if np.isnan(adi) or np.isnan(cv2):
            demand_class = "intermittent"
        elif adi >= scfg.intermittent_adi and cv2 >= scfg.intermittent_cv2:
            demand_class = "intermittent"
        elif adi < scfg.intermittent_adi and cv2 < scfg.intermittent_cv2:
            demand_class = "smooth"
        elif cv2 >= scfg.intermittent_cv2:  # frequent but highly variable
            demand_class = "erratic"
        else:  # sparse but regular sizes
            demand_class = "lumpy"
        # routing flag is ADI-only (SPEC §10: "Intermittent (ADI >= 1.32)");
        # undefined ADI cannot establish intermittency -> False
        intermittent = bool(not np.isnan(adi) and adi >= scfg.intermittent_adi)

        # lifecycle from full history up to as_of
        first_week = g["week_start"].min()
        history_weeks = (as_of - first_week).days // 7 + 1
        sold = g.loc[g["units_raw"] > 0, "week_start"]
        last_sale = sold.max() if not sold.empty else pd.NaT
        if pd.isna(last_sale) or (as_of - last_sale).days >= 7 * scfg.dormancy_weeks:
            lifecycle = "dormant"
        elif history_weeks < NEW_WEEKS:
            lifecycle = "new"
        else:
            lifecycle = "active"

        rep_price = float(gw["price_median"].median()) if gw["price_median"].notna().any() else np.nan
        rows.append(
            {
                "sku": sku,
                "location": loc,
                "xyz": xyz,
                "adi": adi,
                "cv2": cv2,
                "demand_class": demand_class,
                "intermittent_flag": intermittent,
                "lifecycle": lifecycle,
                "_units52": float(np.nan_to_num(gw["units_raw"].to_numpy(dtype=float), nan=0.0).sum()),
                "_rep_price": rep_price,
            }
        )

    seg = pd.DataFrame(rows)

    # --- value basis for ABC ------------------------------------------------
    if price_lookup is not None and not price_lookup.empty:
        lookup = dict(zip(price_lookup["sku"].astype(str), price_lookup["price"].astype(float)))
        seg["_rep_price"] = seg["_rep_price"].fillna(seg["sku"].map(lookup))
    if seg["_rep_price"].notna().any():
        seg["_rep_price"] = seg["_rep_price"].fillna(seg["_rep_price"].median())
        seg["_value"] = seg["_units52"] * seg["_rep_price"]
    else:
        seg["_value"] = seg["_units52"]  # no price anywhere → units basis

    # --- ABC by cumulative share within each location -----------------------
    seg["abc"] = "C"
    for _, part in seg.groupby("location"):
        order = part.sort_values(["_value", "sku"], ascending=[False, True]).index
        values = seg.loc[order, "_value"].clip(lower=0.0)
        total = values.sum()
        if total > 0:
            cum = values.cumsum() / total
            seg.loc[order, "abc"] = np.where(
                cum <= abc_a + _EPS, "A", np.where(cum <= abc_b + _EPS, "B", "C")
            )

    # --- routing cell -------------------------------------------------------
    def _route(r) -> str:
        if r["intermittent_flag"]:
            return "intermittent"
        if r["lifecycle"] in ("new", "dormant"):
            return r["lifecycle"]
        return f"{r['abc']}{r['xyz']}"

    seg["segment"] = seg.apply(_route, axis=1)
    seg = seg[["sku", "location", "abc", "xyz", "adi", "cv2", "demand_class",
               "intermittent_flag", "lifecycle", "segment"]]
    return SegmentSchema.validate(seg)

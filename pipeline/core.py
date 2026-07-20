#!/usr/bin/env python3
"""
core.py - BatCrunch shared layer: raw acquisition + compute + JSON writers.
Imported by build.py (backfill) and update.py (nightly). Not run directly.
"""

import os, sys, json, tempfile, datetime as dt
import numpy as np
import pandas as pd

from savant import (pull_raw, pull_expected, pull_sprint, pull_bat_tracking,
                    pull_swing_path, pull_position, pull_rolling, pull_custom)

CURRENT_YEAR = 2026
SEASON = {
    2025: ("2025-03-27", "2025-09-28"),
    2026: ("2026-03-26", None),          # None -> today
}

# One-time backfill: freeze each season to zstd parquet(s), each < GitHub 100MB.
# {year: (split_date_or_None, end_or_None)}  split None -> single file; end None -> today
HALVES = {
    2025: ("2025-07-15", "2025-09-28"),
    2026: (None, None),                   # single file, through today
}

SWING = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play"}
WHIFF = {"swinging_strike", "swinging_strike_blocked", "foul_tip"}
K_EVENTS = {"strikeout", "strikeout_double_play"}
BB_EVENTS = {"walk", "intent_walk"}


# ----------------------------------------------------------------------------- #
# Raw acquisition: frozen seasons cached to parquet, current season always fresh
# ----------------------------------------------------------------------------- #
# All inputs/outputs live in the sibling data/ dir (repo-root/data), regardless of CWD.
DATA_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
os.makedirs(DATA_DIR, exist_ok=True)


def dpath(name):
    return os.path.join(DATA_DIR, name)


def get_raw(year):
    split, h2_end = HALVES[year]
    start, _ = SEASON[year]
    single = dpath(f"raw_{year}.parquet")
    h1, h2 = dpath(f"raw_{year}-H1.parquet"), dpath(f"raw_{year}-H2.parquet")

    # cache hit
    if split is None and os.path.exists(single):
        print(f"raw {year}: cached")
        return pd.read_parquet(single)
    if split is not None and os.path.exists(h1) and os.path.exists(h2):
        print(f"raw {year}: cached (2 parts)")
        return pd.concat([pd.read_parquet(h1), pd.read_parquet(h2)], ignore_index=True)

    end = h2_end or dt.date.today().isoformat()
    print(f"raw {year}: pulling {start}..{end}" + (f" (split at {split})" if split else ""))
    raw = pull_raw(start, end, chunk_days=5)

    if split is None:
        raw.to_parquet(single, compression="zstd", compression_level=19)
        mb = os.path.getsize(single) / 1e6
        print(f"raw {year}: {len(raw):>6} rows, {mb:.1f}MB")
        if mb >= 100:
            print(f"  WARN: raw_{year}.parquet >= 100MB; add a split date.")
        return raw

    # game_date is an ISO string and pull_raw returns it sorted -> lexical slice is safe.
    part1 = raw[raw["game_date"] < split]
    part2 = raw[raw["game_date"] >= split]
    part1.to_parquet(h1, compression="zstd", compression_level=19)
    part2.to_parquet(h2, compression="zstd", compression_level=19)
    for tag, path, part in (("H1", h1, part1), ("H2", h2, part2)):
        mb = os.path.getsize(path) / 1e6
        print(f"raw {year} {tag}: {len(part):>6} rows, {mb:.1f}MB")
        if mb >= 100:
            print(f"  WARN: raw_{year}-{tag}.parquet >= 100MB; move the split date or go to thirds.")
    return raw


# ----------------------------------------------------------------------------- #
# Compute (raw -> per-batter scalars). Identical for both years.
# ----------------------------------------------------------------------------- #
def pa_frame(raw):
    return raw[raw["events"].notna()].copy()


def batter_team(raw):
    pa = pa_frame(raw).sort_values(["game_date", "game_pk", "at_bat_number"])
    pa["team"] = np.where(pa["inning_topbot"].eq("Top"), pa["away_team"], pa["home_team"])
    return pa.groupby("batter")["team"].last()


def compute_production(raw, pa=None):
    """PA count + a vectorized wOBA fallback. Savant's woba overwrites this wherever
    the expected-stats board has the player; k/bb now come from the custom board."""
    pa = pa_frame(raw) if pa is None else pa
    nb = pa[pa["events"] != "intent_walk"]
    g = nb.groupby("batter")
    den = g["woba_denom"].sum()
    return pd.DataFrame({
        "pa":   pa.groupby("batter").size(),
        "woba": g["woba_value"].sum() / den.replace(0, np.nan),
    })


def compute_splits(raw, pa=None):
    pa = pa_frame(raw) if pa is None else pa
    switch = pa.groupby("batter")["stand"].nunique().gt(1)
    rows = {}
    for hand in ("L", "R"):
        side = pa[pa["p_throws"] == hand]
        rows[f"pa_{hand}"] = side.groupby("batter").size()
        g = side[side["events"] != "intent_walk"].groupby("batter")
        den = g["woba_denom"].sum()
        rows[f"woba_{hand}"] = g["woba_value"].sum() / den.replace(0, np.nan)
    out = pd.DataFrame(rows)
    out["switch"] = switch.reindex(out.index).fillna(False)
    return out


_PA_AGG = ["d_pitches", "d_inzone", "d_swing", "d_zswing", "d_oswing",
          "d_zcontact", "d_ocontact", "d_whiff", "d_bbe", "ev_sum", "hardhit",
          "n_sw", "bs_sum", "sl_sum", "aa_sum", "ad_sum", "tilt_sum", "n_ideal"]


def _pa_pitch_aggs(raw):
    """Per-PA pitch-level counts/sums. Discipline counts mirror compute_discipline
    (bunts excluded, in-zone = 1..9, contact = swing & ~whiff) so season == rolling.
    Bat-tracking emitted as sums + a swing count so the JS rolls rate = sum/count
    (keeps fillna(0) correct - no nulls)."""
    nb = ~raw["description"].str.contains("bunt", na=False)
    d = raw[nb].copy()
    for c in ["bat_speed", "swing_length", "attack_angle", "attack_direction",
              "swing_path_tilt", "launch_speed"]:
        d[c] = pd.to_numeric(d[c], errors="coerce") if c in d.columns else np.nan
    desc = d["description"]
    sw  = desc.isin(SWING).values
    wh  = desc.isin(WHIFF).values
    con = sw & ~wh
    iz  = d["zone"].between(1, 9).values
    tracked = sw & d["bat_speed"].notna().values
    # Savant "competitive swings": fastest 90% of a player's swings, plus any 60+ mph
    # swing resulting in 90+ mph EV. Threshold is per-batter/per-season, so it is
    # recomputed on every build from the full-season raw both callers pass in.
    _thr  = d.loc[tracked].groupby("batter")["bat_speed"].quantile(0.10)
    thr_v = d["batter"].map(_thr).to_numpy(dtype="float64")
    bs_v  = d["bat_speed"].to_numpy(dtype="float64")
    ev_v  = d["launch_speed"].fillna(0.0).to_numpy(dtype="float64")
    with np.errstate(invalid="ignore"):
        bt = tracked & ((bs_v >= thr_v) | ((bs_v >= 60.0) & (ev_v >= 90.0)))
    # d_pitches exists only so the JS can derive out-of-zone as (d_pitches - d_inzone).
    # Statcast leaves ~0.4% of pitches with a null zone; counting them made them
    # out-of-zone by default and dragged O-Swing%/O-Contact% low. Only zone-classified
    # pitches count, so (d_pitches - d_inzone) == zone 11-14 exactly.
    d["d_pitches"]  = d["zone"].between(1, 14).astype(int)
    d["d_inzone"]   = iz.astype(int)
    d["d_swing"]    = sw.astype(int)
    d["d_zswing"]   = (sw & iz).astype(int)
    d["d_oswing"]   = (sw & ~iz).astype(int)
    d["d_zcontact"] = (con & iz).astype(int)
    d["d_ocontact"] = (con & ~iz).astype(int)
    d["d_whiff"]    = wh.astype(int)
    # A batted-ball event is a ball put IN PLAY. Fouls carry a tracked launch_speed
    # too (~255 of 530 tracked rows for a typical hitter), so gating on launch_speed
    # alone nearly doubles the denominator and halves Barrel%/HardHit%.
    bip = (d["description"] == "hit_into_play").values & d["launch_speed"].notna().values
    d["d_bbe"]      = bip.astype(int)
    d["ev_sum"]     = np.where(bip, d["launch_speed"].fillna(0.0), 0.0)
    d["hardhit"]    = (bip & (d["launch_speed"] >= 95).fillna(False).values).astype(int)
    d["n_sw"]       = bt.astype(int)
    d["bs_sum"]     = np.where(bt, d["bat_speed"].fillna(0.0), 0.0)
    d["sl_sum"]     = np.where(bt, d["swing_length"].fillna(0.0), 0.0)
    d["aa_sum"]     = np.where(bt, d["attack_angle"].fillna(0.0), 0.0)
    d["ad_sum"]     = np.where(bt, d["attack_direction"].fillna(0.0), 0.0)
    d["tilt_sum"]   = np.where(bt, d["swing_path_tilt"].fillna(0.0), 0.0)
    d["n_ideal"]    = (bt & d["attack_angle"].between(5, 20).values).astype(int)
    return d.groupby(["game_pk", "at_bat_number"], as_index=False)[_PA_AGG].sum()


def compute_pa_log(raw):
    """Per-batter chronological PA log; the dashboard rolls windows in JS.
    Row (25 cols): woba_value, woba_denom, xv, brl, bbe, kf, bbf,
    then _PA_AGG (discipline counts + EV/hardhit + bat-tracking sums)."""
    pa = pa_frame(raw)
    pa = pa.merge(_pa_pitch_aggs(raw), on=["game_pk", "at_bat_number"], how="left")
    pa = pa.sort_values(["batter", "game_date", "game_pk", "at_bat_number"])
    pa.loc[pa["events"] == "intent_walk", ["woba_value", "woba_denom"]] = 0
    ewu = pa["estimated_woba_using_speedangle"]
    bip = pa["launch_speed"].notna()          # real tracked batted ball; K/BB/HBP use woba_value
    pa = pa.assign(
        xv=np.where(bip & ewu.notna(), ewu, pa["woba_value"]),
        brl=(pa["launch_speed_angle"] == 6).astype(int),
        bbe=pa["launch_speed"].notna().astype(int),
        kf=pa["events"].isin(K_EVENTS).astype(int),
        bbf=pa["events"].isin(BB_EVENTS).astype(int),
    )
    cols = (["woba_value", "woba_denom", "xv", "brl", "bbe", "kf", "bbf"] + _PA_AGG)
    log = {}
    for bid, d in pa.groupby("batter"):
        log[int(bid)] = d[cols].fillna(0).round(3).values.tolist()
    return log


def team_games(raw):
    g = pd.concat([
        raw[["game_pk", "home_team"]].rename(columns={"home_team": "team"}),
        raw[["game_pk", "away_team"]].rename(columns={"away_team": "team"}),
    ]).drop_duplicates()
    return int(g.groupby("team")["game_pk"].nunique().max())


def compute_year(year, with_log, raw=None):
    if raw is None:
        raw = get_raw(year)
    pa = pa_frame(raw)                      # one pass, shared by every consumer below
    stats = (compute_production(raw, pa)
             .join(compute_splits(raw, pa))
             .join(pull_custom(year).set_index("id"))
             .join(pull_expected(year).set_index("id"))
             .join(pull_sprint(year).set_index("id"))
             .join(pull_bat_tracking(year).set_index("id"))
             .join(pull_swing_path(year).set_index("id")))
    stats["woba"] = stats["woba_sv"].fillna(stats["woba"])
    stats = stats.drop(columns="woba_sv")
    meta = pd.DataFrame({
        "team": batter_team(raw),
        "name": pa.groupby("batter")["player_name"].first(),
        "hand": pa.groupby("batter")["stand"].agg(lambda s: s.mode().iat[0]),
    })
    qual = round(3.1 * team_games(raw))
    log = compute_pa_log(raw) if with_log else None
    return stats.join(meta), log, qual


# ----------------------------------------------------------------------------- #
# Assemble + coverage gate + write
# ----------------------------------------------------------------------------- #
CORE = ["pa", "woba", "xwoba", "k", "bb", "barrel", "sweet", "ev50",
        "z_swing", "o_swing", "z_contact", "o_contact", "whiff", "sprint"]
BAT_TRACK = ["bat_speed", "swing_length", "attack_angle", "attack_direction", "tilt", "iaa"]
REQUIRED = CORE + BAT_TRACK            # all written; null where missing


def assert_coverage(stats, qual, year):
    q = stats[stats["pa"] >= qual]
    gate = CORE + (BAT_TRACK if year == CURRENT_YEAR else [])
    miss = q[gate].isna()
    bad = q[miss.any(axis=1)].index.tolist()
    if bad:
        per_col = miss.sum()
        per_col = per_col[per_col > 0].sort_values(ascending=False)
        print(f"[coverage] {year}: {len(bad)} of {len(q)} qualified hitters missing gated fields")
        print(per_col.to_string())
        raise SystemExit(1)
    print(f"coverage {year}: {len(q)} qualified OK (qualPA={qual}; bat-tracking gated: {year == CURRENT_YEAR})")


def year_payload(stats, qual, year, also_ids=None, floor=None):
    assert_coverage(stats, qual, year)
    thresh = floor if floor is not None else qual   # emit down to floor (sub-qualified); default = qualified
    mask = stats["pa"] >= thresh
    if also_ids:                            # ... plus current-year-qualified ids (for YoY)
        mask = mask | stats.index.isin(list(also_ids))
    q = stats[mask]
    pos = pull_position(q.index)            # StatsAPI primary position, qualified ids only
    players = {}
    for bid, row in q.iterrows():
        p = {"name": row["name"], "hand": row["hand"], "team": row["team"],
             "position": pos.get(int(bid))}
        for k in REQUIRED:
            p[k] = None if pd.isna(row[k]) else round(float(row[k]), 3)
        p["switch"] = bool(row["switch"])
        for tag in ("L", "R"):
            for s in ("pa", "woba"):
                v = row[f"{s}_{tag}"]
                p[f"{s}_{tag}"] = None if pd.isna(v) else round(float(v), 3)
        players[str(bid)] = p
    return {"qualPA": qual, "players": players}


def write_json(obj, path):
    d = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)  # error, never write Infinity/NaN
    os.replace(tmp, path)


def _savant_roll():
    """Savant's own rolling endpoints (wOBA/xwOBA/BA/xBA/SLG/xSLG, per window).

    Fail-soft on purpose: this is the only scrape of an HTML page (rather than a
    CSV endpoint) in the pipeline, so a Savant layout change degrades to {} and the
    dashboard falls back to its computed series, instead of killing the build.
    """
    try:
        d = pull_rolling(CURRENT_YEAR)
        print(f"savant rolling: {len(d)} batters")
        return {str(k): v for k, v in d.items()}
    except Exception as e:
        print(f"savant rolling: SKIPPED ({e.__class__.__name__}: {e})")
        return {}


def write_current(stats, log, qual):
    """Write current-year data.json + rolling.json (qualified + sub-qualified floor).
    Shared by build.py (full backfill) and update.py (nightly)."""
    floor = 10      # emit everyone down to 10 PA; low-PA flagged in UI, rolling gated separately
    payload = year_payload(stats, qual, CURRENT_YEAR, floor=floor)
    payload["savantRoll"] = _savant_roll()
    write_json(payload, dpath("data.json"))
    qual_ids = set(int(i) for i in stats[stats["pa"] >= qual].index)
    emit_ids = set(int(i) for i in stats[stats["pa"] >= floor].index)
    write_json({str(b): rows for b, rows in log.items() if b in emit_ids}, dpath("rolling.json"))
    print(f"wrote data.json + rolling.json ({len(qual_ids)} qualified, {len(emit_ids)} incl. sub-qualified \u2265{floor} PA)")
    return qual_ids

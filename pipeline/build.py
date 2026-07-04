#!/usr/bin/env python3
"""
build.py - BatCrunch orchestrator. Savant-only, MLBAM-native. Current-year-first.

Writes:
  data.json        2026 scalars, qualified + sub-qualified (≥ half qualPA)  (loads on page open)
  data_2025.json   2025 scalars, qualified only, frozen  (lazy: YoY)
  rolling.json     2026 per-player PA logs, qualified only  (lazy: Rolling tab)

Run:  python build.py
"""

import os, sys, json, tempfile, datetime as dt
import numpy as np
import pandas as pd

from savant import (pull_raw, pull_expected, pull_sprint, pull_bat_tracking,
                    pull_swing_path, pull_position)

CURRENT_YEAR = 2026
SEASON = {
    2025: ("2025-03-27", "2025-09-28"),
    2026: ("2026-03-26", None),          # None -> today
}

SWING = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play"}
WHIFF = {"swinging_strike", "swinging_strike_blocked"}
K_EVENTS = {"strikeout", "strikeout_double_play"}
BB_EVENTS = {"walk"}


# ----------------------------------------------------------------------------- #
# Raw acquisition: frozen seasons cached to parquet, current season always fresh
# ----------------------------------------------------------------------------- #
# All inputs/outputs live in the sibling data/ dir (repo-root/data), regardless of CWD.
DATA_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
os.makedirs(DATA_DIR, exist_ok=True)


def dpath(name):
    return os.path.join(DATA_DIR, name)


def get_raw(year):
    path = dpath(f"raw_{year}.parquet")
    if year < CURRENT_YEAR and os.path.exists(path):
        print(f"raw {year}: cached")
        return pd.read_parquet(path)
    start, end = SEASON[year]
    end = end or dt.date.today().isoformat()
    print(f"raw {year}: pulling {start}..{end}")
    raw = pull_raw(start, end, chunk_days=5)
    if year < CURRENT_YEAR:
        raw.to_parquet(path)
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


def compute_power(raw):
    bb = raw[raw["launch_speed"].notna()]
    g = bb.groupby("batter")
    return pd.DataFrame({
        "barrel": g.apply(lambda d: (d["launch_speed_angle"] == 6).mean() * 100),
        "sweet":  g.apply(lambda d: d["launch_angle"].between(8, 32).mean() * 100),
        "ev90":   g["launch_speed"].quantile(0.90),
    })


def woba_of(d):
    den = d["woba_denom"].sum()
    return d["woba_value"].sum() / den if den else np.nan


def compute_production(raw):
    pa = pa_frame(raw)
    g = pa.groupby("batter")
    return pd.DataFrame({
        "pa":   g.size(),
        "woba": g.apply(lambda d: woba_of(d[d["events"] != "intent_walk"])),
        "k":    g.apply(lambda d: d["events"].isin(K_EVENTS).mean() * 100),
        "bb":   g.apply(lambda d: d["events"].isin(BB_EVENTS).mean() * 100),
    })


def compute_discipline(raw):
    # build a narrow frame instead of assigning onto the wide raw frame (no PerformanceWarning)
    m = ~raw["description"].str.contains("bunt", na=False)
    desc = raw.loc[m, "description"]
    swing = desc.isin(SWING).values
    whiff = desc.isin(WHIFF).values
    p = pd.DataFrame({
        "batter": raw.loc[m, "batter"].values,
        "inzone": raw.loc[m, "zone"].between(1, 9).values,
        "swing":  swing,
        "whiff":  whiff,
        "contact": swing & ~whiff,
    })
    g = p.groupby("batter")

    def rate(num, den):
        n = g.apply(lambda d: int(num(d).sum()))
        m2 = g.apply(lambda d: int(den(d).sum()))
        return (n / m2.replace(0, np.nan)) * 100

    return pd.DataFrame({
        "z_swing":   rate(lambda d: d["swing"] & d["inzone"],    lambda d: d["inzone"]),
        "o_swing":   rate(lambda d: d["swing"] & ~d["inzone"],   lambda d: ~d["inzone"]),
        "z_contact": rate(lambda d: d["contact"] & d["inzone"],  lambda d: d["swing"] & d["inzone"]),
        "o_contact": rate(lambda d: d["contact"] & ~d["inzone"], lambda d: d["swing"] & ~d["inzone"]),
        "whiff":     rate(lambda d: d["whiff"],                   lambda d: d["swing"]),
    })


def compute_splits(raw):
    pa = pa_frame(raw)
    rows = {}
    switch = pa.groupby("batter")["stand"].nunique().gt(1)
    for hand in ("L", "R"):
        side = pa[pa["p_throws"] == hand].groupby("batter")
        rows[f"pa_{hand}"]   = side.size()
        # guard 0-denom platoon sides so they yield NaN (-> null), never inf
        rows[f"woba_{hand}"] = side.apply(
            lambda d: woba_of(d[d["events"] != "intent_walk"]))
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
    bt  = sw & d["bat_speed"].notna().values
    d["d_pitches"]  = 1
    d["d_inzone"]   = iz.astype(int)
    d["d_swing"]    = sw.astype(int)
    d["d_zswing"]   = (sw & iz).astype(int)
    d["d_oswing"]   = (sw & ~iz).astype(int)
    d["d_zcontact"] = (con & iz).astype(int)
    d["d_ocontact"] = (con & ~iz).astype(int)
    d["d_whiff"]    = wh.astype(int)
    d["d_bbe"]      = d["launch_speed"].notna().astype(int)
    d["ev_sum"]     = d["launch_speed"].fillna(0.0)
    d["hardhit"]    = (d["launch_speed"] >= 95).fillna(False).astype(int)
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
    Row (27 cols): woba_value, woba_denom, xv, brl, bbe, kf, bbf, zone_in, pitches,
    then _PA_AGG (discipline counts + EV/hardhit + bat-tracking sums)."""
    pc = (raw.assign(_z=raw["zone"].between(1, 9))
             .groupby(["game_pk", "at_bat_number"])
             .agg(pitches=("zone", "size"), zone_in=("_z", "sum"))
             .reset_index())
    pa = pa_frame(raw).merge(pc, on=["game_pk", "at_bat_number"], how="left")
    pa = pa.merge(_pa_pitch_aggs(raw), on=["game_pk", "at_bat_number"], how="left")
    pa = pa.sort_values(["batter", "game_date", "game_pk", "at_bat_number"])
    pa.loc[pa["events"] == "intent_walk", ["woba_value", "woba_denom"]] = 0
    ewu = pa["estimated_woba_using_speedangle"]
    pa = pa.assign(
        xv=np.where(ewu.notna(), ewu, pa["woba_value"]),
        brl=(pa["launch_speed_angle"] == 6).astype(int),
        bbe=pa["launch_speed"].notna().astype(int),
        kf=pa["events"].isin(K_EVENTS).astype(int),
        bbf=pa["events"].isin(BB_EVENTS).astype(int),
    )
    cols = (["woba_value", "woba_denom", "xv", "brl", "bbe", "kf", "bbf",
             "zone_in", "pitches"] + _PA_AGG)
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


def compute_year(year, with_log):
    raw = get_raw(year)
    stats = (compute_production(raw)
             .join(compute_power(raw))
             .join(compute_discipline(raw))
             .join(compute_splits(raw))
             .join(pull_expected(year).set_index("id"))
             .join(pull_sprint(year).set_index("id"))
             .join(pull_bat_tracking(year).set_index("id"))
             .join(pull_swing_path(year).set_index("id")))
    stats["woba"] = stats["woba_sv"].fillna(stats["woba"])
    stats = stats.drop(columns="woba_sv")
    pa = pa_frame(raw)
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
CORE = ["pa", "woba", "xwoba", "k", "bb", "barrel", "sweet", "ev90",
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


if __name__ == "__main__":
    current_only = "--current-only" in sys.argv or os.environ.get("BATCRUNCH_CURRENT_ONLY") == "1"

    # current year: scalars + rolling log, both qualified-only
    stats, log, qual = compute_year(CURRENT_YEAR, with_log=True)
    floor = max(50, round(qual * 0.5))      # permissive floor: emit sub-qualified down to ~half qualPA
    write_json(year_payload(stats, qual, CURRENT_YEAR, floor=floor), dpath("data.json"))
    qual_ids = set(int(i) for i in stats[stats["pa"] >= qual].index)
    emit_ids = set(int(i) for i in stats[stats["pa"] >= floor].index)
    write_json({str(b): rows for b, rows in log.items() if b in emit_ids}, dpath("rolling.json"))
    print(f"wrote data.json + rolling.json ({len(qual_ids)} qualified, {len(emit_ids)} incl. sub-qualified \u2265{floor} PA)")

    if current_only:
        print("current-only: skipping frozen past years")
        sys.exit(0)

    # past years: frozen scalars only, no rolling
    for y in sorted(SEASON):
        if y == CURRENT_YEAR:
            continue
        s, _, q = compute_year(y, with_log=False)
        write_json(year_payload(s, q, y, also_ids=qual_ids), dpath(f"data_{y}.json"))
        print(f"wrote data_{y}.json")

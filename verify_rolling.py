#!/usr/bin/env python3
"""verify_rolling.py - season-invariant check for every rolling series.

Each stat is produced twice by independent code paths:
  bars    <- compute_production / compute_power / compute_discipline, or a Savant pull
  rolling <- _pa_pitch_aggs -> per-PA rows in rolling.json -> summed in JS

Rolling a FULL-SEASON window must reproduce the bar. Where the bar is a Savant
pull, that is a match-Savant test. Where the bar is computed locally, it is an
internal-consistency test. Either way, a red row means the two paths disagree.

Run from repo root:  python verify_rolling.py [n_players]
"""

import json
import os
import sys

DATA = os.path.join("data", "data.json")
ROLL = os.path.join("data", "rolling.json")

# idx map into a rolling.json row (see core.compute_pa_log)
WV, WD, XV, BRL, BBE, KF, BBF = range(7)
DPIT, DINZ, DSW, DZSW, DOSW, DZC, DWH, DBE, EVS, HH, NSW, BSS, SLS, AAS, ADS, TLS, NID = range(7, 24)


def col(rows, i):
    return sum(r[i] for r in rows)


# name -> (roll_fn(rows), data.json key, source of the bar, tolerance)
CHECKS = [
    ("wOBA",        lambda r: col(r, WV) / col(r, WD) if col(r, WD) else None,
     "woba",  "savant", 0.002),
    ("xwOBA",       lambda r: col(r, XV) / col(r, WD) if col(r, WD) else None,
     "xwoba", "savant", 0.002),
    ("K%",          lambda r: col(r, KF) / len(r) * 100,
     "k",     "local",  0.25),
    ("BB%",         lambda r: col(r, BBF) / len(r) * 100,
     "bb",    "local",  0.25),
    ("Barrel%",     lambda r: col(r, BRL) / col(r, DBE) * 100 if col(r, DBE) else None,
     "barrel", "local", 0.30),
    ("Z-Swing%",    lambda r: col(r, DZSW) / col(r, DINZ) * 100 if col(r, DINZ) else None,
     "z_swing", "local", 0.25),
    ("O-Swing%",    lambda r: col(r, DOSW) / (col(r, DPIT) - col(r, DINZ)) * 100
     if (col(r, DPIT) - col(r, DINZ)) else None,
     "o_swing", "local", 0.25),
    ("Z-Contact%",  lambda r: col(r, DZC) / col(r, DZSW) * 100 if col(r, DZSW) else None,
     "z_contact", "local", 0.25),
    ("Whiff%",      lambda r: col(r, DWH) / col(r, DSW) * 100 if col(r, DSW) else None,
     "whiff", "local", 0.25),
    # --- the competitive-swing group: bars are Savant pulls, rolling is ours ---
    ("Bat speed",   lambda r: col(r, BSS) / col(r, NSW) if col(r, NSW) else None,
     "bat_speed", "savant", 0.25),
    ("Swing length", lambda r: col(r, SLS) / col(r, NSW) if col(r, NSW) else None,
     "swing_length", "savant", 0.05),
    ("Attack angle", lambda r: col(r, AAS) / col(r, NSW) if col(r, NSW) else None,
     "attack_angle", "savant", 0.50),
    ("Attack dir",  lambda r: col(r, ADS) / col(r, NSW) if col(r, NSW) else None,
     "attack_direction", "savant", 0.50),
    ("Tilt",        lambda r: col(r, TLS) / col(r, NSW) if col(r, NSW) else None,
     "tilt", "savant", 0.30),
    ("Ideal AA%",   lambda r: col(r, NID) / col(r, NSW) * 100 if col(r, NSW) else None,
     "iaa", "savant", 1.00),
]


def main(limit):
    players = json.load(open(DATA))["players"]
    rolling = json.load(open(ROLL))

    # biggest samples first -- small samples are noisy and not informative
    ids = sorted((p for p in rolling if p in players),
                 key=lambda p: -(players[p].get("pa") or 0))[:limit]
    print(f"checking {len(ids)} players (largest PA first)\n")

    agg = {}
    for pid in ids:
        rows = rolling[pid]
        bar = players[pid]
        for name, fn, key, src, tol in CHECKS:
            want = bar.get(key)
            if want is None:
                continue
            try:
                got = fn(rows)
            except ZeroDivisionError:
                got = None
            if got is None:
                continue
            d = got - want
            a = agg.setdefault(name, {"src": src, "tol": tol, "n": 0, "bad": 0,
                                      "sum": 0.0, "worst": (0.0, None)})
            a["n"] += 1
            a["sum"] += d
            if abs(d) > tol:
                a["bad"] += 1
            if abs(d) > abs(a["worst"][0]):
                a["worst"] = (d, bar.get("name"))

    print(f"{'stat':<14}{'bar src':<9}{'n':>4}{'mean d':>10}{'worst d':>10}  {'':<3}{'verdict'}")
    print("-" * 78)
    for name, fn, key, src, tol in CHECKS:
        a = agg.get(name)
        if not a:
            print(f"{name:<14}{src:<9}{'-':>4}{'':>10}{'':>10}   no data")
            continue
        mean = a["sum"] / a["n"]
        ok = a["bad"] == 0
        mark = "OK " if ok else "OFF"
        note = "" if ok else f"  {a['bad']}/{a['n']} outside +/-{a['tol']}  (worst: {a['worst'][1]})"
        print(f"{name:<14}{a['src']:<9}{a['n']:>4}{mean:>+10.3f}{a['worst'][0]:>+10.3f}   {mark}{note}")

    print("\nbar src 'savant' -> disagreement means we do not match Savant's method")
    print("bar src 'local'  -> disagreement means our own two code paths disagree (a bug)")
    print("\nNote: rolling EV is mean exit velo; the bar is ev90 (90th pct). Not comparable, so not checked.")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 40)

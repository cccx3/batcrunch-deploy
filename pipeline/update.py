#!/usr/bin/env python3
"""
update.py - BatCrunch nightly. Refreshes the current-year parquet with a trailing
window (Savant retro-corrects games for ~1-2 days after they're played), recomputes
data.json + rolling.json. Reuses build.py's compute + write layer.

Run:  python update.py            # trailing 5-day overwrite window
      python update.py 10         # custom window length in days
"""

import sys, datetime as dt
import pandas as pd

from core import (CURRENT_YEAR, SEASON, dpath, pull_raw,
                  compute_year, write_current)

OVERWRITE_DAYS = 5          # re-pull this trailing window to absorb retro-corrections
DEDUP_KEY = ["game_pk", "at_bat_number", "pitch_number"]


def main(window_days):
    path = dpath(f"raw_{CURRENT_YEAR}.parquet")
    old = pd.read_parquet(path)
    print(f"extant parquet: {len(old):>7} rows through {old['game_date'].max()}")

    start, _ = SEASON[CURRENT_YEAR]
    today = dt.date.today()
    win_start = max(
        dt.date.fromisoformat(start),
        today - dt.timedelta(days=window_days - 1),
    ).isoformat()
    win_end = today.isoformat()

    print(f"pulling window {win_start}..{win_end}")
    fresh = pull_raw(win_start, win_end, chunk_days=5)
    if fresh.empty:
        print("no rows in window; nothing to do")
        return

    # drop the window from the extant frame, splice in the fresh pull, dedup as a guard
    kept = old[old["game_date"] < win_start]
    merged = (pd.concat([kept, fresh], ignore_index=True)
                .drop_duplicates(subset=DEDUP_KEY, keep="last")
                .sort_values(["game_date", "game_pk", "at_bat_number", "pitch_number"]))

    # sanity guard: never let a bad pull shrink the season
    if len(merged) < len(old):
        raise SystemExit(
            f"ABORT: merged {len(merged)} < extant {len(old)} rows; refusing to overwrite")

    merged.to_parquet(path, compression="zstd", compression_level=19)
    print(f"parquet: {len(merged):>7} rows through {merged['game_date'].max()}")

    stats, log, qual = compute_year(CURRENT_YEAR, with_log=True, raw=merged)
    write_current(stats, log, qual)


if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else OVERWRITE_DAYS
    main(days)

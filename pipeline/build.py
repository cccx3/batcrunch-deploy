#!/usr/bin/env python3
"""
build.py - BatCrunch one-time backfill. Freezes each season to zstd parquet(s),
recomputes all JSON. Reuses core.py. Nightly refresh is update.py.

Writes:
  data.json        current-year scalars, qualified + sub-qualified  (loads on page open)
  data_2025.json   frozen past-year scalars, qualified  (lazy: YoY)
  rolling.json     current-year per-player PA logs  (lazy: Rolling tab)

Run:  python build.py            # all seasons
      python build.py --current-only
"""

import os, sys

from core import (CURRENT_YEAR, SEASON, dpath,
                  compute_year, write_current, write_json, year_payload)

if __name__ == "__main__":
    current_only = "--current-only" in sys.argv or os.environ.get("BATCRUNCH_CURRENT_ONLY") == "1"

    # current year: scalars + rolling log
    stats, log, qual = compute_year(CURRENT_YEAR, with_log=True)
    qual_ids = write_current(stats, log, qual)

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

#!/usr/bin/env python3
"""
savant.py - every Savant data helper in one place: the HTTP primitive plus all five
pulls. build.py imports what it needs from here. Replaces savant_http.py and the five
pull_*.py files.

Per-component smoke tests via the dispatcher:
    python savant.py raw [start end]          # default: last 3 days
    python savant.py expected      [year]
    python savant.py sprint        [year]
    python savant.py bat_tracking  [year]
    python savant.py swing_path    [year]
    python savant.py rolling       [year]
"""

import io, sys, time, json, datetime as dt
import requests
import pandas as pd


# --------------------------------------------------------------------------- #
# HTTP primitive
# --------------------------------------------------------------------------- #
HEADERS = {"User-Agent": "Mozilla/5.0"}
TIMEOUT = 90


def get_csv(url, retries=4):
    """GET a Savant CSV with backoff. Raises on persistent failure or error payload."""
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            if r.status_code == 200 and r.text.strip():
                df = pd.read_csv(io.StringIO(r.text))
                if "error" in df.columns:          # Savant can 200 with an in-band error
                    raise RuntimeError(df["error"].iloc[0])
                return df
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = str(e)
        time.sleep(2 ** attempt)                    # 1, 2, 4, 8s
    raise RuntimeError(f"failed after {retries} tries: {last}")


def get_html(url, retries=4):
    """GET a Savant HTML page with backoff. Used by the rolling board, whose payload
    is embedded as a JS object literal rather than exposed as CSV."""
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers={**HEADERS, "Accept-Encoding": "identity"},
                             timeout=TIMEOUT)
            if r.status_code == 200 and r.text.strip():
                return r.text
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = str(e)
        time.sleep(2 ** attempt)
    raise RuntimeError(f"failed after {retries} tries: {last}")


# --------------------------------------------------------------------------- #
# Raw pitch-level Statcast (chunked under the 30k-row cap) - structurally its own thing
# --------------------------------------------------------------------------- #
_RAW_URL = (
    "https://baseballsavant.mlb.com/statcast_search/csv?all=true"
    "&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones="
    "&hfGT=R%7C&hfSea=&hfSit=&player_type=batter&hfOuts="
    "&opponent=&pitcher_throws=&batter_stands=&hfSA="
    "&game_date_gt={start}&game_date_lt={end}"
    "&team=&position=&hfRO=&home_road=&hfFlag=&metric_1=&hfInn="
    "&min_pitches=0&min_results=0&group_by=name&sort_col=pitches"
    "&player_event_sort=api_p_release_speed&sort_order=desc&min_abs=0&type=details"
)

# Columns the build.py compute layer reads. If any go missing, compute breaks silently.
RAW_REQUIRED = [
    "batter", "player_name", "game_date", "game_pk", "at_bat_number", "pitch_number",
    "events", "description", "zone", "stand", "p_throws",
    "woba_value", "woba_denom", "estimated_woba_using_speedangle",
    "launch_speed", "launch_angle", "launch_speed_angle",
    "home_team", "away_team", "inning_topbot",
]


def _windows(start, end, days):
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    while s <= e:
        w = min(s + dt.timedelta(days=days - 1), e)
        yield s.isoformat(), w.isoformat()
        s = w + dt.timedelta(days=1)


def pull_raw(start, end, chunk_days=5, verbose=True):
    """All pitch-level rows in [start, end], chunked under Savant's 30k-row cap."""
    frames = []
    for ws, we in _windows(start, end, chunk_days):
        df = get_csv(_RAW_URL.format(start=ws, end=we))
        n = 0 if df is None else len(df)
        if n:
            frames.append(df)
        if verbose:
            print(f"  {ws}..{we}: {n:>6} rows")
        if n >= 30000:
            print(f"  WARN: {ws}..{we} hit the 30k cap; lower chunk_days.")
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    return out.sort_values(["game_date", "game_pk", "at_bat_number", "pitch_number"])


# --------------------------------------------------------------------------- #
# Leaderboard pulls - each owns only its URL + rename + keep (+ scale where needed)
# --------------------------------------------------------------------------- #
_EXPECTED_URL = ("https://baseballsavant.mlb.com/leaderboard/expected_statistics"
                 "?type=batter&year={year}&position=&team=&filterType=bip&min=0&csv=true")
_EXPECTED_RENAME = {"player_id": "id", "est_woba": "xwoba", "woba": "woba_sv"}
_EXPECTED_KEEP = ["id", "woba_sv", "xwoba"]


def pull_expected(year):
    df = get_csv(_EXPECTED_URL.format(year=year)).rename(columns=_EXPECTED_RENAME)
    missing = [c for c in _EXPECTED_KEEP if c not in df.columns]
    if missing:
        raise KeyError(f"expected: missing {missing}; real cols: {list(df.columns)}")
    return df[_EXPECTED_KEEP]


_SPRINT_URL = ("https://baseballsavant.mlb.com/leaderboard/sprint_speed"
               "?year={year}&position=&team=&min=0&csv=true")
_SPRINT_RENAME = {"player_id": "id", "sprint_speed": "sprint"}
_SPRINT_KEEP = ["id", "sprint"]


def pull_sprint(year):
    df = get_csv(_SPRINT_URL.format(year=year)).rename(columns=_SPRINT_RENAME)
    missing = [c for c in _SPRINT_KEEP if c not in df.columns]
    if missing:
        raise KeyError(f"sprint: missing {missing}; real cols: {list(df.columns)}")
    return df[_SPRINT_KEEP]


# NOTE: the bat-tracking boards ignore `min`; the real knob is `minSwings`.
_BAT_TRACKING_URL = ("https://baseballsavant.mlb.com/leaderboard/bat-tracking"
                     "?attackZone=&batSide=&year={year}&minSwings=0&type=batter&csv=true")
_BAT_TRACKING_RENAME = {"avg_bat_speed": "bat_speed"}
_BAT_TRACKING_KEEP = ["id", "bat_speed", "swing_length"]


def pull_bat_tracking(year):
    df = get_csv(_BAT_TRACKING_URL.format(year=year)).rename(columns=_BAT_TRACKING_RENAME)
    missing = [c for c in _BAT_TRACKING_KEEP if c not in df.columns]
    if missing:
        raise KeyError(f"bat_tracking: missing {missing}; real cols: {list(df.columns)}")
    return df[_BAT_TRACKING_KEEP]


# Separate endpoint (attack angle/direction/tilt/ideal-AA aren't on the bat-tracking board).
_SWING_PATH_URL = ("https://baseballsavant.mlb.com/leaderboard/bat-tracking/swing-path-attack-angle"
                   "?attackZone=&batSide=&year={year}&minSwings=0&type=batter&csv=true")
_SWING_PATH_RENAME = {"swing_tilt": "tilt", "ideal_attack_angle_rate": "iaa"}
_SWING_PATH_KEEP = ["id", "attack_angle", "attack_direction", "tilt", "iaa"]


def pull_swing_path(year):
    df = get_csv(_SWING_PATH_URL.format(year=year)).rename(columns=_SWING_PATH_RENAME)
    missing = [c for c in _SWING_PATH_KEEP if c not in df.columns]
    if missing:
        raise KeyError(f"swing_path: missing {missing}; real cols: {list(df.columns)}")
    df["iaa"] = df["iaa"] * 100        # board gives a 0-1 rate; dashboard wants percent
    return df[_SWING_PATH_KEEP]


# Rolling Windows board. No CSV export: the page embeds the whole league as a raw
# JS object literal (NOT quote-wrapped), keyed Batter50/Batter100/Batter250. Only six
# stats roll on Savant, and only the endpoint + prior point are exposed - no curve.
_ROLLING_URL = ("https://baseballsavant.mlb.com/leaderboard/rolling"
                "?season={year}&type=batter")
_ROLLING_STATS = ("woba", "xwoba", "ba", "xba", "slg", "xslg")
_ROLLING_WINDOWS = (50, 100, 250)


def _rolling_object(html):
    i = html.find("var rolling")
    if i < 0:
        raise RuntimeError("`var rolling` not found; Savant page layout changed")
    b = html.find("{", i)
    depth, instr, esc = 0, False, False
    for k in range(b, len(html)):
        ch = html[k]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            instr = not instr
        if instr:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(html[b:k + 1])
    raise RuntimeError("unbalanced braces in rolling payload")


def pull_rolling(year):
    """-> {int id: {"50"|"100"|"250": {stat: {"last": x, "prev": y}}}} for all batters."""
    data = _rolling_object(get_html(_ROLLING_URL.format(year=year)))
    out = {}
    for w in _ROLLING_WINDOWS:
        for r in data.get(f"Batter{w}") or []:
            pid = r.get("player_id")
            if pid is None:
                continue
            slot = out.setdefault(int(pid), {}).setdefault(str(w), {})
            for st in _ROLLING_STATS:
                last = r.get(f"last_x_{st}")
                if last is not None:
                    slot[st] = {"last": last, "prev": r.get(f"penultimate_x_{st}")}
    return out


# --------------------------------------------------------------------------- #
# Primary fielding position - MLB StatsAPI (JSON). The one field not on Savant.
# --------------------------------------------------------------------------- #
_STATSAPI_PEOPLE = "https://statsapi.mlb.com/api/v1/people?personIds={ids}"
_POS_NORMALIZE = {"LF": "OF", "CF": "OF", "RF": "OF", "TWP": "DH"}   # outfield -> OF; two-way -> DH


def pull_position(ids, chunk=100):
    """MLBAM id -> primary fielding position abbreviation (outfield collapsed to OF).
    Batched StatsAPI call, id-keyed (no name-join). Returns {int id: pos | None}."""
    ids = [int(i) for i in ids]
    out = {}
    for i in range(0, len(ids), chunk):
        batch = ids[i:i + chunk]
        r = requests.get(_STATSAPI_PEOPLE.format(ids=",".join(map(str, batch))),
                         headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        for person in r.json().get("people", []):
            pos = (person.get("primaryPosition") or {}).get("abbreviation")
            out[person["id"]] = _POS_NORMALIZE.get(pos, pos)
    return out


# --------------------------------------------------------------------------- #
# Dispatcher: per-component smoke test
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "expected"

    if cmd == "raw":
        if len(sys.argv) == 4:
            start, end = sys.argv[2], sys.argv[3]
        else:
            today = dt.date.today()
            start, end = (today - dt.timedelta(days=3)).isoformat(), today.isoformat()
        print(f"raw {start}..{end}:")
        raw = pull_raw(start, end)
        print(f"  total {len(raw):,} rows")
        if not raw.empty:
            missing = [c for c in RAW_REQUIRED if c not in raw.columns]
            print(f"  MISSING columns: {missing}" if missing else "  all required columns present")
    else:
        year = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
        if cmd == "rolling":
            d = pull_rolling(year)
            print(f"rolling {year}: {len(d)} batters | sample (Yordan 670541):")
            y = d.get(670541) or {}
            for w in ("50", "100", "250"):
                x = (y.get(w) or {}).get("xwoba")
                if x:
                    print(f"  {w:>3} PA  xwOBA last={x['last']} prev={x['prev']}")
            sys.exit(0)
        fn = {"expected": pull_expected, "sprint": pull_sprint,
              "bat_tracking": pull_bat_tracking, "swing_path": pull_swing_path}[cmd]
        out = fn(year)
        print(f"{cmd} {year}: {len(out)} rows | sample:")
        print(out.head(3).to_string(index=False))

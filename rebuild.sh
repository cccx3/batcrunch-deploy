#!/usr/bin/env bash
# Rebuild current-season data.json + rolling.json. Run from repo root: bash rebuild.sh
set -euo pipefail
cd "$(dirname "$0")"

# use the active venv if there is one; otherwise fall back to pipeline/.venv
if [ -z "${VIRTUAL_ENV:-}" ] && [ -f pipeline/.venv/bin/activate ]; then
  source pipeline/.venv/bin/activate
fi

python pipeline/build.py --current-only
echo "done - review git diff, then commit data/"

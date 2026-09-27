#!/usr/bin/env bash
# Launch Process City. Creates a local virtualenv with psutil on first run.
# Usage: ./run.sh [--port 8765] [--interval 1.5] [--allow-signals] [--no-browser]
#        sudo ./run.sh   # to inspect every user's processes in full
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "python3 is required (3.9+)." >&2
  exit 1
fi

if "$PY" -c 'import psutil' >/dev/null 2>&1; then
  exec "$PY" -m livecity "$@"
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: creating .venv and installing psutil…"
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r requirements.txt
fi
exec .venv/bin/python -m livecity "$@"

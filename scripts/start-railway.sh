#!/usr/bin/env bash
# Single Railway service: Part2 + Part3 + Part1 (public UI).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PART2_API="${PART2_API:-http://127.0.0.1:8787}"
export PART3_API="${PART3_API:-http://127.0.0.1:8788}"
export PART1_API="${PART1_API:-http://127.0.0.1:8765}"
export HOST="${HOST:-0.0.0.0}"

# Internal ports for agent + pay; public PORT is for the web UI.
(
  cd part2_linq
  PORT=8787 npm start
) &
PID2=$!

(
  cd part3_prava
  PORT=8788 npm start
) &
PID3=$!

cleanup() {
  kill "$PID2" "$PID3" 2>/dev/null || true
}
trap cleanup EXIT

echo "[railway] waiting for Part2/Part3…"
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:8787/health" >/dev/null \
    && curl -sf "http://127.0.0.1:8788/health" >/dev/null; then
    echo "[railway] Part2 + Part3 healthy"
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    echo "[railway] Part2/Part3 failed to become healthy" >&2
    exit 1
  fi
done

# Prefer Railway PORT for the public web UI.
cd part1_vision
exec python3 web_live.py

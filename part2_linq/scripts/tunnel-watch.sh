#!/usr/bin/env bash
# Keep a public HTTPS tunnel alive for Linq webhooks (localtunnel dies often).
# Usage:  npm run tunnel:watch
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"

while true; do
  echo "[tunnel:watch] starting localtunnel → :$PORT"
  # Print URL to a temp file as localtunnel starts
  npx --yes localtunnel --port "$PORT" 2>&1 | tee /tmp/milkwatch-tunnel.log &
  TPID=$!
  URL=""
  for i in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9.-]+\.loca\.lt' /tmp/milkwatch-tunnel.log | tail -1 || true)
    if [ -n "$URL" ]; then break; fi
    sleep 1
  done
  if [ -z "$URL" ]; then
    echo "[tunnel:watch] no URL yet — retry"
    kill "$TPID" 2>/dev/null || true
    sleep 2
    continue
  fi
  echo "[tunnel:watch] URL=$URL — subscribing Linq"
  WEBHOOK_PUBLIC_URL="$URL" npx tsx src/subscribe-webhook.ts || true
  # update .env
  if grep -q '^WEBHOOK_PUBLIC_URL=' .env 2>/dev/null; then
    perl -i -pe "s|^WEBHOOK_PUBLIC_URL=.*|WEBHOOK_PUBLIC_URL=$URL|" .env
  else
    echo "WEBHOOK_PUBLIC_URL=$URL" >> .env
  fi
  # wait until process dies
  wait "$TPID" || true
  echo "[tunnel:watch] tunnel exited — restarting in 3s"
  sleep 3
done

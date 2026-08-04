#!/usr/bin/env bash
# Run this ON THE VPS, from the repo root, after pulling the latest code.
set -euo pipefail

echo "== Installing production dependencies =="
cd functions
npm ci --omit=dev
cd ..

mkdir -p logs

echo "== Verifying functions/.env exists =="
if [ ! -f functions/.env ]; then
  echo "ERROR: functions/.env is missing. Copy functions/.env.production.example to functions/.env and fill in real values first." >&2
  exit 1
fi

echo "== Reloading with PM2 (zero-downtime if already running) =="
if pm2 describe twittence > /dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.js
else
  pm2 start deploy/ecosystem.config.js
fi
pm2 save

echo "== Done. Tail logs with: pm2 logs twittence =="

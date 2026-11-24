#!/usr/bin/env bash
# Local smoke test: start the API, hit every endpoint, stop it.
set -u
cd "$(dirname "$0")/.."
APP_VERSION=v1 PORT=3000 node src/app.js >/tmp/orders-api-smoke.log 2>&1 &
SRV=$!
for i in $(seq 1 50); do
  curl -sf localhost:3000/live >/dev/null 2>&1 && break
  sleep 0.1
done
echo "--- GET /health ---"; curl -si localhost:3000/health | sed -n '1p;/^X-App-Version/p;$p'
echo "--- GET /api/orders ---"; curl -s localhost:3000/api/orders | head -c 220; echo
echo "--- GET /api/orders/2 ---"; curl -s localhost:3000/api/orders/2; echo
echo "--- GET /metrics (extrait) ---"; curl -s localhost:3000/metrics | grep -E '^http_requests_total' | head -5
echo "--- GET /inconnu ---"; curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/inconnu
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
echo "server stopped"

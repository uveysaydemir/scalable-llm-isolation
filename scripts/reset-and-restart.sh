#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
QDRANT_URL="${QDRANT_URL:-http://127.0.0.1:6333}"
MEMORY_URL="${MEMORY_URL:-http://127.0.0.1:8090}"
LEFT_EDGE_URL="${LEFT_EDGE_URL:-http://127.0.0.1:8080}"
RIGHT_EDGE_URL="${RIGHT_EDGE_URL:-http://127.0.0.1:8083}"
QDRANT_COLLECTION="${QDRANT_COLLECTION:-global_memory}"

if [ -f ".env" ]; then
  ENV_COLLECTION="$(grep -E '^QDRANT_COLLECTION=' .env | tail -n 1 | cut -d '=' -f 2- || true)"
  if [ -n "$ENV_COLLECTION" ]; then
    QDRANT_COLLECTION="$ENV_COLLECTION"
  fi
fi

wait_for_http() {
  local url="$1"
  local name="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$name is ready"
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for $name at $url" >&2
  return 1
}

stop_dashboard() {
  local pids
  pids="$(lsof -tiTCP:"$DASHBOARD_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    echo "No dashboard process found on port $DASHBOARD_PORT"
    return 0
  fi

  echo "Stopping dashboard process(es) on port $DASHBOARD_PORT: $pids"
  kill $pids 2>/dev/null || true
  sleep 1
}

echo "Starting Docker services if needed..."
docker compose up -d

echo "Waiting for Qdrant..."
wait_for_http "$QDRANT_URL/collections" "Qdrant"

echo "Deleting Qdrant collection: $QDRANT_COLLECTION"
curl -fsS -X DELETE "$QDRANT_URL/collections/$QDRANT_COLLECTION" >/dev/null || true

echo "Restarting Docker services to clear edge STM/LTM and reload memory-layer..."
docker compose restart

echo "Waiting for services..."
wait_for_http "$MEMORY_URL/health" "memory-layer" 90
wait_for_http "$LEFT_EDGE_URL/health" "left edge" 90
wait_for_http "$RIGHT_EDGE_URL/health" "right edge" 90

stop_dashboard

echo "Starting dashboard on port $DASHBOARD_PORT..."
pnpm --dir dashboard dev --host 0.0.0.0

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}══════════════════════════════════════${NC}"; echo -e "${BOLD}${CYAN}  $*${NC}"; echo -e "${BOLD}${CYAN}══════════════════════════════════════${NC}"; }

# ─── Cleanup on exit ──────────────────────────────────────────────────────────
DASHBOARD_PID=""
cleanup() {
  echo ""
  info "Shutting down..."
  if [[ -n "$DASHBOARD_PID" ]] && kill -0 "$DASHBOARD_PID" 2>/dev/null; then
    info "Stopping dashboard (PID $DASHBOARD_PID)..."
    kill "$DASHBOARD_PID" 2>/dev/null || true
  fi
  info "Stopping Docker services..."
  docker compose down
  success "All services stopped."
}
trap cleanup EXIT INT TERM

# ─── Prerequisites ────────────────────────────────────────────────────────────
header "Checking prerequisites"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    success "$1 found"
  else
    error "$1 is required but not installed. Please install it and re-run."
    exit 1
  fi
}

check_cmd docker

if ! command -v npm &>/dev/null; then
  error "npm is required but not installed. Install Node.js (https://nodejs.org) and re-run."
  exit 1
fi
success "npm found"

if ! command -v pnpm &>/dev/null; then
  warn "pnpm not found — installing via npm..."
  npm install -g pnpm
  success "pnpm installed"
else
  success "pnpm found"
fi

# Docker daemon must be running
if ! docker info &>/dev/null; then
  error "Docker daemon is not running. Please start Docker and re-run."
  exit 1
fi
success "Docker daemon is running"

# ─── Environment file ─────────────────────────────────────────────────────────
header "Environment"

if [[ ! -f .env ]]; then
  warn ".env not found — copying from .env.example"
  cp .env.example .env
  success "Created .env from .env.example (edit it if needed)"
else
  success ".env already exists"
fi

# ─── Docker Compose ───────────────────────────────────────────────────────────
header "Starting infrastructure (Docker Compose)"

info "Building images and starting services..."
info "Note: First run pulls Ollama models — this may take several minutes."

docker compose up --build -d

success "Docker Compose services started"

# ─── Wait for edge nodes ──────────────────────────────────────────────────────
header "Waiting for edge nodes to become healthy"

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-60}"
  local attempt=0

  info "Waiting for $name at $url ..."
  while ! curl -sf "$url" &>/dev/null; do
    attempt=$((attempt + 1))
    if [[ $attempt -ge $max_attempts ]]; then
      error "$name did not become healthy after $((max_attempts * 5)) seconds."
      error "Check logs: docker compose logs $name"
      exit 1
    fi
    sleep 5
  done
  success "$name is healthy"
}

# Memory layer has a long start_period (90 s) due to Ollama warm-up
wait_for_http "memory-layer"    "http://localhost:8090/health" 60
wait_for_http "edge-node-left"  "http://localhost:8080/health" 30
wait_for_http "edge-node-right" "http://localhost:8083/health" 30

# ─── Dashboard ────────────────────────────────────────────────────────────────
header "Starting dashboard"

info "Installing Node dependencies..."
pnpm install

info "Launching dashboard dev server on http://localhost:5173 ..."
pnpm --filter dashboard dev &>/tmp/dashboard.log &
DASHBOARD_PID=$!

# Give Vite a moment to start
sleep 3
if ! kill -0 "$DASHBOARD_PID" 2>/dev/null; then
  error "Dashboard failed to start. Check /tmp/dashboard.log"
  exit 1
fi
success "Dashboard running (PID $DASHBOARD_PID) — logs: /tmp/dashboard.log"

# ─── Summary ──────────────────────────────────────────────────────────────────
header "System is UP"

echo -e ""
echo -e "  ${BOLD}Service              URL${NC}"
echo -e "  ─────────────────────────────────────────"
echo -e "  Dashboard            ${GREEN}http://localhost:5173${NC}"
echo -e "  Edge Node Left       ${GREEN}http://localhost:8080${NC}"
echo -e "  Edge Node Right      ${GREEN}http://localhost:8083${NC}"
echo -e "  Memory Layer         ${GREEN}http://localhost:8090${NC}"
echo -e "  Qdrant (vector DB)   ${GREEN}http://localhost:6333${NC}"
echo -e "  Ollama (LLM)         ${GREEN}http://localhost:11434${NC}"
echo -e ""
echo -e "  ${YELLOW}Press Ctrl-C to stop the dashboard and exit.${NC}"
echo -e "  ${YELLOW}To stop Docker services: docker compose down${NC}"
echo -e ""

# Keep script alive so the dashboard process stays in the foreground
wait "$DASHBOARD_PID"

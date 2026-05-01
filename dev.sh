#!/usr/bin/env bash
# dev.sh — démarre le backend (FastAPI) et le frontend (Vite) depuis la racine du repo
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

log()  { echo -e "${GREEN}[dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[dev]${NC} $*"; }
die()  { echo -e "${RED}[dev]${NC} $*" >&2; exit 1; }

# ── Prérequis ────────────────────────────────────────────────────────────────
command -v uv   >/dev/null 2>&1 || die "uv non trouvé — https://docs.astral.sh/uv/getting-started/installation/"
command -v pnpm >/dev/null 2>&1 || die "pnpm non trouvé — npm install -g pnpm"

# ── data/ ────────────────────────────────────────────────────────────────────
mkdir -p "$ROOT/data/pdfs" "$ROOT/data/vectors"

# ── Dépendances ───────────────────────────────────────────────────────────────
log "Sync dépendances backend..."
(cd "$BACKEND" && uv sync --quiet)

log "Sync dépendances frontend..."
(cd "$FRONTEND" && pnpm install --frozen-lockfile --silent)

# ── Démarrage ────────────────────────────────────────────────────────────────
BACKEND_LOG="$ROOT/backend.log"
FRONTEND_LOG="$ROOT/frontend.log"

log "Démarrage backend  → http://localhost:8000  (logs: backend.log)"
(cd "$BACKEND" && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) \
  >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

log "Démarrage frontend → http://localhost:5173  (logs: frontend.log)"
(cd "$FRONTEND" && pnpm dev) >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

# ── Attente disponibilité backend ────────────────────────────────────────────
warn "En attente du backend..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    log "Backend prêt."
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    die "Backend crashé — voir backend.log"
  fi
  sleep 1
done

# ── Cleanup à Ctrl+C ─────────────────────────────────────────────────────────
cleanup() {
  echo ""
  log "Arrêt..."
  kill "$BACKEND_PID"  2>/dev/null || true
  kill "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID"  2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
  log "Arrêté."
}
trap cleanup EXIT INT TERM

log "Tout tourne. Ctrl+C pour arrêter."
log "  Backend  → http://localhost:8000/docs"
log "  Frontend → http://localhost:5173"

# Affiche les erreurs en temps réel si l'un des process meurt
wait "$BACKEND_PID" "$FRONTEND_PID"

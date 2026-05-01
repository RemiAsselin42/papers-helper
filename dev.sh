#!/usr/bin/env bash
# dev.sh — démarre le backend (FastAPI) et le frontend (Vite) depuis la racine du repo
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'

log()  { printf "%b[info]%b %s\n" "${GREEN}" "${NC}" "$*"; }
load() { printf "%b[load]%b %s\n" "${YELLOW}" "${NC}" "$*"; }
warn() { printf "%b[warn]%b %s\n" "${YELLOW}" "${NC}" "$*"; }
end()  { printf "%b[end]%b %s\n" "${RED}" "${NC}" "$*"; }
die()  { printf "%b[error]%b %s\n" "${RED}" "${NC}" "$*" >&2; exit 1; }

# ── Prérequis ────────────────────────────────────────────────────────────────
command -v uv   >/dev/null 2>&1 || die "uv non trouvé — https://docs.astral.sh/uv/getting-started/installation/"
command -v pnpm >/dev/null 2>&1 || die "pnpm non trouvé — npm install -g pnpm"

# ── data/ ────────────────────────────────────────────────────────────────────
mkdir -p "$ROOT/data/pdfs" "$ROOT/data/vectors"

# ── Dépendances ───────────────────────────────────────────────────────────────
(cd "$BACKEND" && uv sync --quiet)

(cd "$FRONTEND" && pnpm install --frozen-lockfile --silent)

# ── Démarrage ────────────────────────────────────────────────────────────────
BACKEND_LOG="$ROOT/backend.log"
FRONTEND_LOG="$ROOT/frontend.log"

load "Démarrage backend (logs: $(cygpath -w "$BACKEND_LOG"))"
(cd "$BACKEND" && NO_COLOR=1 uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) \
  >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

load "Démarrage frontend (logs: $(cygpath -w "$FRONTEND_LOG"))"
(cd "$FRONTEND" && NO_COLOR=1 pnpm dev) >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

# ── Attente disponibilité backend ────────────────────────────────────────────
load "En attente du backend..."
echo ""
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    log "Backend  → http://localhost:8000/docs"
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    die "Backend crashé — voir backend.log"
  fi
  sleep 1
done

# ── Cleanup à Ctrl+C ─────────────────────────────────────────────────────────
CLEANUP_DONE=0
cleanup() {
  if [ "$CLEANUP_DONE" -eq 1 ]; then
    return
  fi
  CLEANUP_DONE=1
  echo ""
  end "Arrêt..."
  kill "$BACKEND_PID"  2>/dev/null || true
  kill "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID"  2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
  end "Arrêté."
  exit 0
}
trap cleanup EXIT INT TERM

log "Frontend → http://localhost:5173"

# Affiche les erreurs en temps réel si l'un des process meurt
wait "$BACKEND_PID" "$FRONTEND_PID"

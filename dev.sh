#!/usr/bin/env bash
# dev.sh — démarre le backend (FastAPI) et le frontend (Vite) avec monitoring robuste
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

log()   { printf "%b[info]%b %s\n" "${GREEN}" "${NC}" "$*"; }
load()  { printf "%b[load]%b %s\n" "${YELLOW}" "${NC}" "$*"; }
warn()  { printf "%b[warn]%b %s\n" "${YELLOW}" "${NC}" "$*"; }
error() { printf "%b[err]%b %s\n" "${RED}" "${NC}" "$*" >&2; }
end()   { printf "%b[end]%b %s\n" "${RED}" "${NC}" "$*"; }
die()   { printf "%b[error]%b %s\n" "${RED}" "${NC}" "$*" >&2; exit 1; }
debug() { if [[ "${DEBUG:-0}" == "1" ]]; then printf "%b[debug]%b %s\n" "${CYAN}" "${NC}" "$*"; fi; }

# ── Global State ─────────────────────────────────────────────────────────────
declare -A PIDS
declare -A NAMES
declare -A START_TIMES
declare -A LOGFILES
CLEANUP_DONE=0
MONITOR_THREAD_PID=""

# ── Prérequis ────────────────────────────────────────────────────────────────
command -v uv   >/dev/null 2>&1 || die "uv non trouvé — https://docs.astral.sh/uv/getting-started/installation/"
command -v pnpm >/dev/null 2>&1 || die "pnpm non trouvé — npm install -g pnpm"

# ── data/ ────────────────────────────────────────────────────────────────────
mkdir -p "$ROOT/data/pdfs" "$ROOT/data/vectors"

# ── Dépendances ───────────────────────────────────────────────────────────────
(cd "$BACKEND" && uv sync --quiet)
(cd "$FRONTEND" && pnpm install --frozen-lockfile --silent)

# ── System Health Checks ─────────────────────────────────────────────────────
check_system_health() {
  local check_name="$1"
  local threshold="${2:-90}"
  
  case "$check_name" in
    memory)
      # Check available memory (simplified for Linux/WSL; adjust for macOS)
      if command -v free >/dev/null 2>&1; then
        local available_mem
        available_mem=$(free | awk '/^Mem:/ {print int($7 / $2 * 100)}')
        if [ "$available_mem" -lt $((100 - threshold)) ]; then
          warn "Low memory available: ${available_mem}% free (threshold: $((100 - threshold))%)"
          return 1
        fi
      fi
      ;;
    inodes)
      # Check inotify limit
      if [ -f /proc/sys/fs/inotify/max_user_watches ]; then
        local max_watches current_watches
        max_watches=$(cat /proc/sys/fs/inotify/max_user_watches)
        current_watches=$(find /proc/[0-9]*/fd -lname "anon_inode:inotify" 2>/dev/null | wc -l || echo 0)
        local usage=$((current_watches * 100 / max_watches))
        if [ "$usage" -gt "$threshold" ]; then
          error "inotify limit near exhaustion: $current_watches / $max_watches ($usage%) — increase with: sudo sysctl -w fs.inotify.max_user_watches=524288"
          return 1
        fi
        debug "inotify usage: $current_watches / $max_watches ($usage%)"
      fi
      ;;
    disk)
      # Check disk space
      local disk_usage
      disk_usage=$(df "$ROOT" | awk 'NR==2 {print int($5)}')
      if [ "$disk_usage" -gt "$threshold" ]; then
        error "Low disk space on $ROOT: ${disk_usage}% used (threshold: $threshold%)"
        return 1
      fi
      debug "Disk usage on $ROOT: ${disk_usage}%"
      ;;
    fds)
      # Check file descriptor limits
      if [ -d /proc/self/fd ]; then
        local current_fds max_fds
        current_fds=$(ls -1 /proc/self/fd 2>/dev/null | wc -l)
        max_fds=$(ulimit -n)
        local usage=$((current_fds * 100 / max_fds))
        if [ "$usage" -gt "$threshold" ]; then
          error "FD limit near exhaustion: $current_fds / $max_fds ($usage%)"
          return 1
        fi
        debug "FD usage: $current_fds / $max_fds ($usage%)"
      fi
      ;;
  esac
  
  return 0
}

# ── Process Management ───────────────────────────────────────────────────────
register_process() {
  local name="$1"
  local pid="$2"
  local logfile="$3"
  
  PIDS["$name"]="$pid"
  NAMES["$pid"]="$name"
  START_TIMES["$name"]=$(date +%s)
  LOGFILES["$name"]="$logfile"
  
  log "[$name] Started (PID: $pid, log: $(cygpath -w "$logfile" 2>/dev/null || echo "$logfile"))"
}

check_process_alive() {
  local name="$1"
  local pid="${PIDS[$name]}"
  
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  return 0
}

get_process_uptime() {
  local name="$1"
  local start_time="${START_TIMES[$name]}"
  local current_time
  current_time=$(date +%s)
  echo $((current_time - start_time))
}

get_process_exit_status() {
  local pid="$1"
  local exit_code
  
  # Non-blocking wait to get exit status
  if wait -n "$pid" 2>/dev/null; then
    exit_code=0
  else
    exit_code=$?
  fi
  
  echo "$exit_code"
}

# ── Process Monitoring Thread ───────────────────────────────────────────────
monitor_processes() {
  debug "Process monitor thread started"
  local check_counter=0
  
  while true; do
    # Check each registered process
    for name in "${!PIDS[@]}"; do
      local pid="${PIDS[$name]}"
      local logfile="${LOGFILES[$name]}"
      
      if ! check_process_alive "$name"; then
        # Process died — capture last 20 lines of log
        local uptime
        uptime=$(get_process_uptime "$name")
        
        error "[$name] Died unexpectedly after ${uptime}s (PID: $pid)"
        error "[$name] Recent logs:"
        
        if [ -f "$logfile" ]; then
          tail -20 "$logfile" | sed 's/^/  ['"$name"'] /'
        fi
        
        # Trigger cleanup and exit monitor
        return 1
      fi
    done
    
    # System health checks every 5 iterations
    ((check_counter++)) || true
    if [ $((check_counter % 5)) -eq 0 ]; then
      for check_type in memory inodes fds; do
        if ! check_system_health "$check_type"; then
          error "[$check_type] System health check failed — processes may fail soon"
        fi
      done
    fi
    
    sleep 2
  done
}

# ── Wait for Backend Health ───────────────────────────────────────────────────
wait_for_backend() {
  local max_attempts=30
  local attempt=0
  
  load "Waiting for backend health check..."
  
  while [ $attempt -lt $max_attempts ]; do
    if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
      log "Backend → http://localhost:8000/docs"
      return 0
    fi
    
    # Check if backend process is still alive
    if ! check_process_alive "backend"; then
      error "Backend process died before becoming healthy"
      error "Last logs:"
      if [ -f "${LOGFILES[backend]}" ]; then
        tail -30 "${LOGFILES[backend]}" | sed 's/^/  [backend] /'
      fi
      return 1
    fi
    
    ((attempt++))
    sleep 1
  done
  
  error "Backend did not become healthy within ${max_attempts}s"
  return 1
}

# ── Cleanup Handler ──────────────────────────────────────────────────────────
cleanup() {
  if [ "$CLEANUP_DONE" -eq 1 ]; then
    return 0
  fi
  CLEANUP_DONE=1
  
  # Kill monitor thread if running
  if [ -n "$MONITOR_THREAD_PID" ] && kill -0 "$MONITOR_THREAD_PID" 2>/dev/null; then
    kill "$MONITOR_THREAD_PID" 2>/dev/null || true
    wait "$MONITOR_THREAD_PID" 2>/dev/null || true
  fi
  
  echo ""
  end "Shutting down..."
  
  # Kill all registered processes (reverse order)
  for name in $(printf '%s\n' "${!PIDS[@]}" | sort -r); do
    local pid="${PIDS[$name]}"
    
    if kill -0 "$pid" 2>/dev/null; then
      debug "Terminating [$name] (PID: $pid)"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  
  # Wait for graceful termination (5s timeout)
  local timeout=5
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local all_dead=1
    
    for name in "${!PIDS[@]}"; do
      if kill -0 "${PIDS[$name]}" 2>/dev/null; then
        all_dead=0
        break
      fi
    done
    
    if [ "$all_dead" -eq 1 ]; then
      break
    fi
    
    sleep 0.5
    ((elapsed++))
  done
  
  # Force kill any remaining processes
  for name in "${!PIDS[@]}"; do
    local pid="${PIDS[$name]}"
    if kill -0 "$pid" 2>/dev/null; then
      debug "Force-killing [$name] (PID: $pid)"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  
  # Final wait for all PIDs
  for name in "${!PIDS[@]}"; do
    wait "${PIDS[$name]}" 2>/dev/null || true
  done
  
  end "Shutdown complete."
  exit 0
}

# ── Setup trap handlers ──────────────────────────────────────────────────────
trap cleanup EXIT INT TERM

# ── Startup ──────────────────────────────────────────────────────────────────
BACKEND_LOG="$ROOT/backend.log"
FRONTEND_LOG="$ROOT/frontend.log"

# Clear old logs
: > "$BACKEND_LOG"
: > "$FRONTEND_LOG"

load "Starting backend (logs: $(cygpath -w "$BACKEND_LOG" 2>/dev/null || echo "$BACKEND_LOG"))"
(cd "$BACKEND" && NO_COLOR=1 uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) \
  >>"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
register_process "backend" "$BACKEND_PID" "$BACKEND_LOG"

# Wait for backend to start before starting frontend
sleep 2

load "Starting frontend (logs: $(cygpath -w "$FRONTEND_LOG" 2>/dev/null || echo "$FRONTEND_LOG"))"
(cd "$FRONTEND" && NO_COLOR=1 pnpm dev) >>"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!
register_process "frontend" "$FRONTEND_PID" "$FRONTEND_LOG"

# Wait for backend to become healthy
if ! wait_for_backend; then
  error "Failed to start backend"
  exit 1
fi

log "Frontend → http://localhost:5173"

# Start background monitor thread
monitor_processes &
MONITOR_THREAD_PID=$!
debug "Monitor thread PID: $MONITOR_THREAD_PID"

# Wait indefinitely (trap will handle signals)
echo ""
log "Development environment running. Press Ctrl+C to stop."

# This will block until a process dies or we receive a signal
wait

# If we get here, one of the processes died
error "Unexpected exit from wait() — check logs above"
exit 1

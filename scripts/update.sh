#!/usr/bin/env bash
set -euo pipefail

# EcoFlow Monitor — Update Script
# Pulls latest code, rebuilds frontend, restarts service.
# Run as root:  sudo bash update.sh

APP_DIR="/opt/ecoflow-monitor"
SERVICE_NAME="ecoflow-monitor"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

[[ $EUID -eq 0 ]] || err "Run as root: sudo bash update.sh"
[[ -d "$APP_DIR" ]] || err "App not installed at $APP_DIR. Run install.sh first."

cd "$APP_DIR"

# ── Determine repo location ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LOCAL_REPO=false
if [[ -d "$APP_DIR/.git" ]]; then
    cd "$APP_DIR"
elif [[ -d "$REPO_ROOT/.git" ]]; then
    # Running from inside the repo — update in place
    log "Updating from local repo: $REPO_ROOT"
    cd "$REPO_ROOT"
    LOCAL_REPO=true
else
    err "App not installed. Run install.sh first."
fi

# ── Pull latest ────────────────────────────────────────────────────
log "Pulling latest code..."
# Reset generated files that conflict with clean repo state
git checkout -- package-lock.json 2>/dev/null || true
export GIT_TERMINAL_PROMPT=0
git fetch origin
CURRENT=$(git rev-parse HEAD)
git pull --rebase origin main || git pull --rebase origin master || git pull origin main || git pull origin master
NEW=$(git rev-parse HEAD)

if [[ "$CURRENT" == "$NEW" ]]; then
    log "Already up to date."
    exit 0
fi

log "Updated from ${CURRENT:0:8} to ${NEW:0:8}"

# ── Install & build ────────────────────────────────────────────────
log "Installing dependencies..."
npm install --include=dev

log "Building frontend..."
npx vite build

log "Removing dev dependencies..."
npm prune --omit=dev

# ── Copy to app directory (when updating from local repo) ─────────
if $LOCAL_REPO; then
    log "Copying updated code to $APP_DIR ..."
    rsync -a --delete --exclude node_modules --exclude data --exclude .git "$REPO_ROOT/" "$APP_DIR/"
fi

# ── Restart service ────────────────────────────────────────────────
log "Restarting service..."
systemctl restart "$SERVICE_NAME"

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "Update complete! Service is running."
    log "  Status: systemctl status $SERVICE_NAME"
    log "  Logs:   journalctl -u $SERVICE_NAME -f"
else
    err "Service failed to start. Check logs: journalctl -u $SERVICE_NAME -e"
fi

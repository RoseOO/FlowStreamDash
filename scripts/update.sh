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

# ── Pull latest ────────────────────────────────────────────────────
log "Pulling latest code..."
git fetch origin
CURRENT=$(git rev-parse HEAD)
git pull origin main || git pull origin master
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

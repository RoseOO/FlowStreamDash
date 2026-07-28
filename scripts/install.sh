#!/usr/bin/env bash
set -euo pipefail

# EcoFlow Monitor — Install Script for Debian/Ubuntu
# Clones repo, installs deps, builds frontend, sets up systemd service.
# Run as root or with sudo:  sudo bash install.sh

APP_DIR="/opt/ecoflow-monitor"
DATA_DIR="/var/lib/ecoflow-monitor"
SERVICE_NAME="ecoflow-monitor"
REPO_URL="${REPO_URL:-https://github.com/RoseOO/FlowStreamDash.git}"
NODE_MIN_VERSION=18

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || err "Run as root: sudo bash install.sh"

if ! command -v node &>/dev/null; then
    err "Node.js is not installed. Install Node.js >= ${NODE_MIN_VERSION} first."
fi
NODE_PATH=$(command -v node)
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[[ $NODE_MAJOR -ge $NODE_MIN_VERSION ]] || err "Node.js >= ${NODE_MIN_VERSION} required (found v$(node -v))"

# ── Clone or copy repo ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -d "$APP_DIR/.git" ]]; then
    log "App already installed at $APP_DIR, updating..."
    cd "$APP_DIR"
    git pull origin main || git pull origin master || true
elif [[ -d "$REPO_ROOT/.git" ]]; then
    # Running from within the repo — copy it
    log "Installing from local repo: $REPO_ROOT"
    cp -r "$REPO_ROOT" "$APP_DIR"
    cd "$APP_DIR"
else
    # Clone fresh
    if [[ "$REPO_URL" == *"your-username"* ]]; then
        err "Set REPO_URL environment variable to your actual repo. Example:
  REPO_URL=https://github.com/you/ecoflow-monitor.git sudo bash install.sh"
    fi
    log "Cloning repository from $REPO_URL ..."
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

# ── Install dependencies ───────────────────────────────────────────
log "Installing Node.js dependencies..."
npm install --omit=dev

log "Installing dev dependencies for build..."
npm install --include=dev

log "Building frontend..."
npx vite build

log "Removing dev dependencies..."
npm prune --omit=dev

# ── Create data directory ──────────────────────────────────────────
mkdir -p "$DATA_DIR"
chown -R ecoflow:ecoflow "$DATA_DIR" 2>/dev/null || {
    # Create user if it doesn't exist
    if ! id ecoflow &>/dev/null; then
        useradd --system --no-create-home --home-dir "$APP_DIR" ecoflow
    fi
    chown -R ecoflow:ecoflow "$DATA_DIR"
}
chown -R ecoflow:ecoflow "$APP_DIR"

# ── Symlink data directory ─────────────────────────────────────────
rm -rf "$APP_DIR/data" 2>/dev/null || true
ln -sf "$DATA_DIR" "$APP_DIR/data"

# ── Install systemd service ────────────────────────────────────────
log "Installing systemd service..."
cat > /etc/systemd/system/${SERVICE_NAME}.service << SERVICEEOF
[Unit]
Description=EcoFlow Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ecoflow
Group=ecoflow
WorkingDirectory=/opt/ecoflow-monitor
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=$NODE_PATH server/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ecoflow-monitor

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/ecoflow-monitor /opt/ecoflow-monitor/data
ReadOnlyPaths=/opt/ecoflow-monitor
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ── Done ───────────────────────────────────────────────────────────
log ""
log "Install complete!"
log "  Service:  systemctl status $SERVICE_NAME"
log "  Logs:     journalctl -u $SERVICE_NAME -f"
log "  Web UI:   http://$(hostname -I | awk '{print $1}'):3000"
log ""
log "Access the web UI and create your admin account."

#!/usr/bin/env bash
# Installs nvtop-tracker as a systemd service on Ubuntu.
# Usage: sudo ./deploy/install.sh [service-user]   (default: the user who ran sudo)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo $0 [service-user]" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC_USER="${1:-${SUDO_USER:-}}"
if [[ -z "$SVC_USER" || "$SVC_USER" == root ]]; then
  echo "Pass the non-root user that owns the SSH keys: sudo $0 <user>" >&2
  exit 1
fi
SVC_GROUP="$(id -gn "$SVC_USER")"

# Resolve node from the service user's login shell so nvm/fnm installs are found.
NODE="$(sudo -iu "$SVC_USER" bash -lc 'command -v node' || true)"
if [[ -z "$NODE" ]]; then
  echo "node not found for $SVC_USER. Install Node >= 18 (e.g. sudo apt install nodejs)." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/node_modules" ]]; then
  sudo -iu "$SVC_USER" bash -lc "cd '$APP_DIR' && npm ci --omit=dev"
fi
[[ -f "$APP_DIR/config.json" ]] || echo "WARNING: $APP_DIR/config.json missing; copy config.example.json and edit it." >&2

UNIT=/etc/systemd/system/nvtop-tracker.service
sed -e "s|__USER__|$SVC_USER|g" \
    -e "s|__GROUP__|$SVC_GROUP|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__NODE__|$NODE|g" \
    "$APP_DIR/deploy/nvtop-tracker.service" > "$UNIT"

systemctl daemon-reload
systemctl enable nvtop-tracker
systemctl restart nvtop-tracker
systemctl --no-pager status nvtop-tracker || true
echo "Logs: journalctl -u nvtop-tracker -f"

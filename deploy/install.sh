#!/usr/bin/env bash
# Installs nvtop-tracker as a systemd service on Ubuntu.
# Usage: sudo ./deploy/install.sh [service-user]   (default: the user who ran sudo)
#        sudo NODE=/path/to/node ./deploy/install.sh   (pin the Node binary the service runs)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo $0 [service-user]" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC_USER="${1:-${SUDO_USER:-}}"
if [[ -z "$SVC_USER" || "$SVC_USER" == root ]]; then
  echo "Pass the non-root user that owns the repo: sudo $0 <user>" >&2
  exit 1
fi
SVC_GROUP="$(id -gn "$SVC_USER")"

# Pick the Node the service runs. nvm is usually loaded only by an interactive shell's rc
# file (e.g. ~/.zshrc), so a plain login-shell lookup can land on an old distro
# /usr/bin/node instead. Order: NODE=/path override, the user's nvm default, then
# whatever the user's login shell finds.
NODE="${NODE:-}"
if [[ -z "$NODE" ]]; then
  NODE="$(sudo -iu "$SVC_USER" bash -c '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null && nvm which default' 2>/dev/null || true)"
fi
if [[ -z "$NODE" ]]; then
  NODE="$(sudo -iu "$SVC_USER" bash -lc 'command -v node' || true)"
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "node not found for $SVC_USER. Install Node >= 18, or pass it: sudo NODE=/path/to/node $0" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 18 )); then
  echo "$NODE is Node $("$NODE" --version 2>/dev/null || echo '?'); nvtop-tracker needs Node >= 18." >&2
  echo "Install a newer Node, or pass one: sudo NODE=/path/to/node $0" >&2
  exit 1
fi
echo "Using Node $("$NODE" --version) at $NODE"

if [[ ! -d "$APP_DIR/node_modules" ]]; then
  # Same Node for npm as for the service (npm ships next to node in nvm and distro installs).
  sudo -u "$SVC_USER" env PATH="$(dirname "$NODE"):/usr/bin:/bin" bash -c "cd '$APP_DIR' && npm ci --omit=dev"
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

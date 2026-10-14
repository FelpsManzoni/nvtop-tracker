#!/usr/bin/env bash
# Updates a deployed nvtop-tracker in place: pulls the latest code, installs dependencies,
# and restarts the systemd service (installed by deploy/install.sh).
# Usage: ./deploy/update.sh [branch]   (run as the user who owns the repo, not with sudo)
set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run as the repo owner, without sudo (it asks for sudo only to restart the service)." >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

git fetch
if [[ -n "${1:-}" ]]; then
  git checkout "$1"
fi
git pull --ff-only
npm ci --omit=dev

sudo systemctl restart nvtop-tracker
systemctl --no-pager status nvtop-tracker || true
echo "Logs: journalctl -u nvtop-tracker -f"

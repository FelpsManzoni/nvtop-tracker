#!/usr/bin/env bash
# Removes the nvtop-tracker systemd service. Usage: sudo ./deploy/uninstall.sh
set -euo pipefail
systemctl disable --now nvtop-tracker || true
rm -f /etc/systemd/system/nvtop-tracker.service
systemctl daemon-reload

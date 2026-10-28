#!/usr/bin/env bash
# Prepares this directory for `docker compose up -d --build` on a remote host: one the hub cannot
# reach, so its Prometheus agent remote-writes to the hub instead. Host-specific values only go
# into gitignored files: .env (UID/GID, settings), prometheus-password, agent.yml,
# exporter.config.json and compose.override.yaml. Settings are remembered in .env.
# The password is PROMETHEUS_PASSWORD from the hub's deploy/hub/.env: it is asked for, or read
# from stdin when not a terminal; an existing prometheus-password is kept.
#
#   ./init.sh --name "GPU Server 2" --hub-url http://<hub-host>:19090 [--unified-memory] [--data-disk /data/disk1 ...]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ../common.sh

NAME="" HUB_URL="" UNIFIED="" DISKS=()
while (($#)); do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --hub-url) HUB_URL="$2"; shift 2 ;;
    --unified-memory) UNIFIED=true; shift ;;
    --data-disk) DISKS+=("$2"); shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -n "$NAME" ]] || NAME="$(setting NVTOP_SERVER_NAME)"
[[ -n "$HUB_URL" ]] || HUB_URL="$(setting NVTOP_HUB_URL)"
[[ -n "$UNIFIED" ]] || UNIFIED="$(setting NVTOP_UNIFIED_MEMORY)"
((${#DISKS[@]})) || read -ra DISKS <<<"$(setting NVTOP_DATA_DISKS)"
check_name "$NAME"
check_disks "${DISKS[@]}"
[[ "$HUB_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "Pass --hub-url http://<hub-host>:19090 (the hub's Prometheus)."
[[ "$UNIFIED" == true ]] || UNIFIED=false

mkdir -p agent-data
fill agent.example.yml agent.yml "SERVER_NAME=$NAME" "HUB_URL=$HUB_URL"
write_exporter_config "$UNIFIED" "${DISKS[@]}"
write_compose_override "${DISKS[@]}"

umask 077
cat >.env <<EOF
NVTOP_UID=$(id -u)
NVTOP_GID=$(id -g)
NVTOP_SERVER_NAME="$NAME"
NVTOP_HUB_URL="$HUB_URL"
NVTOP_UNIFIED_MEMORY="$UNIFIED"
NVTOP_DATA_DISKS="${DISKS[*]}"
EOF
if [[ ! -s prometheus-password ]]; then
  if [[ -t 0 ]]; then
    read -rsp "Prometheus password (PROMETHEUS_PASSWORD in the hub's deploy/hub/.env): " PASSWORD
    echo
  else
    PASSWORD="$(cat)"
  fi
  [[ -n "$PASSWORD" ]] || die "No password given."
  printf '%s' "$PASSWORD" >prometheus-password
fi

echo "Ready: docker compose up -d --build"

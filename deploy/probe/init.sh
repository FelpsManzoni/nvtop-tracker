#!/usr/bin/env bash
# Prepares this directory for `docker compose up -d` on the SSH probe machine. Host-specific values
# only go into gitignored files: .env (UID/GID, settings), prometheus-password and agent.yml.
# Settings are remembered in .env. The password is PROMETHEUS_PASSWORD from the hub's
# deploy/hub/.env: it is asked for, or read from stdin when not a terminal; an existing
# prometheus-password is kept. Each --target names a server exactly as in the hub's config.json.
#
#   ./init.sh --hub-url http://<hub-host>:19090 --target "GPU Server 1=<host>[:22]" --target ...
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ../common.sh

HUB_URL="" TARGETS=()
while (($#)); do
  case "$1" in
    --hub-url) HUB_URL="$2"; shift 2 ;;
    --target) TARGETS+=("$2"); shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -n "$HUB_URL" ]] || HUB_URL="$(setting NVTOP_HUB_URL)"
((${#TARGETS[@]})) || IFS=';' read -ra TARGETS <<<"$(setting NVTOP_SSH_TARGETS)"
[[ "$HUB_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "Pass --hub-url http://<hub-host>:19090 (the hub's Prometheus)."
((${#TARGETS[@]})) || die 'Pass --target "<server name>=<host>[:port]" for each server.'

STATIC=""
for t in "${TARGETS[@]}"; do
  name="${t%%=*}" addr="${t#*=}"
  [[ "$t" == *=* ]] || die "--target $t: expected \"<server name>=<host>[:port]\""
  check_name "$name"
  [[ "$addr" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "--target $t: bad host"
  [[ "$addr" == *:* ]] || addr="$addr:22"
  STATIC+="      - targets: [\"$addr\"]"$'\n'"        labels: { server: \"$name\" }"$'\n'
done

mkdir -p agent-data
fill agent.example.yml agent.yml "HUB_URL=$HUB_URL" "TARGETS=${STATIC%$'\n'}"

umask 077
SAVED="$(IFS=';'; echo "${TARGETS[*]}")"
cat >.env <<EOF
NVTOP_UID=$(id -u)
NVTOP_GID=$(id -g)
NVTOP_HUB_URL="$HUB_URL"
NVTOP_SSH_TARGETS="$SAVED"
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

echo "Ready: docker compose up -d"

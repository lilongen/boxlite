#!/usr/bin/env bash
# Install the built BoxLite runner as a systemd service inside the Lima guest.
#
# Runs in `mode: system` (as root). Mirrors the semantic intent of
# apps/infra/sst.config.ts:buildRunnerUserData (env vars, systemctl enable+start)
# but uses the *packaged* boxlite-runner.service + EnvironmentFile instead of
# the inline unit EC2 writes (deliberate divergence; see spec §3 mapping).
set -euo pipefail

# Find the repo. {{.User}} was Lima-rendered to the host username in the yaml
# but provision scripts can't see template vars at exec time — we rely on the
# fact that the mountPoint matches /home/<host_user>.linux/boxlite, and there's
# only one such mount.
REPO="$(find /home -maxdepth 2 -type d -name boxlite -path '*/.linux/boxlite' | head -1)"
if [[ -z "$REPO" || ! -f "$REPO/dist/apps/runner-arm64" ]]; then
    echo "FATAL: runner-arm64 binary not found; build-runner.sh must have run first" >&2
    echo "Looked under: /home/*.linux/boxlite/dist/apps/runner-arm64" >&2
    exit 1
fi
echo "Using repo: $REPO"

# Discover networking
VM_IP="$(ip -j -4 addr show lima0 | jq -r '.[0].addr_info[0].local // empty')"
HOST_GW="$(ip route | awk '/^default/{print $3; exit}')"

if [[ -z "$VM_IP" || -z "$HOST_GW" ]]; then
    echo "FATAL: failed to discover networking (VM_IP='$VM_IP', HOST_GW='$HOST_GW')" >&2
    exit 1
fi
echo "VM_IP=$VM_IP HOST_GW=$HOST_GW"

# Stop any existing service before swapping binary
if systemctl is-active --quiet boxlite-runner.service; then
    systemctl stop boxlite-runner.service
fi

# Install binary
install -d -m 0755 /opt/boxlite
install -m 0755 "${REPO}/dist/apps/runner-arm64" /opt/boxlite/runner

# Install systemd unit (the packaged one — see apps/runner/packaging/systemd/)
install -m 0644 "${REPO}/apps/runner/packaging/systemd/boxlite-runner.service" \
    /etc/systemd/system/boxlite-runner.service

# Required dirs (matches the unit's ReadWritePaths + WorkingDirectory)
install -d -m 0755 /var/lib/boxlite/runner /var/log/boxlite /etc/boxlite

# Render env file. Token matches docs/apps/infra-local-status.md cheatsheet.
# RUNNER_DOMAIN = vmnet IP, mirroring EC2's HOST_IP semantics.
cat > /etc/boxlite/runner.env <<EOF
# Rendered by lima/provision/install-runner.sh at $(date -Is)
BOXLITE_API_URL=http://${HOST_GW}:3001/api
BOXLITE_RUNNER_TOKEN=local-shared-runner-token-aaaa1111
API_VERSION=2
API_PORT=3003
RUNNER_DOMAIN=${VM_IP}
BOXLITE_HOME_DIR=/var/lib/boxlite
INSECURE_REGISTRIES=${HOST_GW}:25000
AWS_REGION=ap-southeast-1
EOF
chmod 600 /etc/boxlite/runner.env

systemctl daemon-reload
systemctl enable boxlite-runner
systemctl restart boxlite-runner

# Smoke check (give the service 3 seconds to settle)
sleep 3
if ! systemctl is-active --quiet boxlite-runner.service; then
    echo "FATAL: boxlite-runner failed to start" >&2
    systemctl status boxlite-runner.service --no-pager --lines=30 || true
    exit 1
fi
echo "boxlite-runner is active. VM_IP=$VM_IP — register at API as RUNNER_DOMAIN."

#!/usr/bin/env bash
# Rebuild the runner inside Lima (from the current source mount) and restart
# the systemd unit. Use after editing runner Go code.
set -euo pipefail

LIMA_NAME="${LIMA_NAME:-boxlite-runner}"

# Use a heredoc piped into shell so we can run multiple commands in one
# `limactl shell` invocation (faster than per-command shells).
limactl shell "$LIMA_NAME" -- sudo -E -u "$(limactl shell "$LIMA_NAME" -- whoami)" bash -lc '
set -euo pipefail
REPO="$(find /home -maxdepth 2 -type d -name boxlite -path "*/.linux/boxlite" | head -1)"
bash "$REPO/apps/infra-local/lima/provision/build-runner.sh"
'

limactl shell "$LIMA_NAME" -- sudo bash -lc '
set -euo pipefail
REPO="$(find /home -maxdepth 2 -type d -name boxlite -path "*/.linux/boxlite" | head -1)"
install -m 0755 "$REPO/dist/apps/runner-arm64" /opt/boxlite/runner
systemctl restart boxlite-runner
sleep 2
systemctl is-active boxlite-runner
'

echo "lima-rebuild done."

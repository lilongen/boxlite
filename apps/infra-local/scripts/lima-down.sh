#!/usr/bin/env bash
# Stop and delete the BoxLite Lima runner VM (data lost).
set -euo pipefail

LIMA_NAME="${LIMA_NAME:-boxlite-runner}"

current_status="$(limactl list --json 2>/dev/null \
  | python3 -c "import json,sys
for line in sys.stdin:
    if not line.strip(): continue
    d=json.loads(line)
    if d.get('name')=='${LIMA_NAME}':
        print(d.get('status',''))
        break")" || true

if [[ -z "$current_status" ]]; then
  echo "Lima VM '${LIMA_NAME}' does not exist; nothing to do."
  exit 0
fi

if [[ "$current_status" == "Running" ]]; then
  echo "Stopping ${LIMA_NAME}..."
  limactl stop "$LIMA_NAME"
fi

echo "Deleting ${LIMA_NAME}..."
limactl delete "$LIMA_NAME"

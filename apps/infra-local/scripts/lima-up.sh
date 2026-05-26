#!/usr/bin/env bash
# Bring up the BoxLite Lima runner VM.
# Idempotent: if already running, exits 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIMA_NAME="${LIMA_NAME:-boxlite-runner}"
LIMA_YAML="${REPO_ROOT}/apps/infra-local/lima/runner.yaml"

if [[ ! -f "$LIMA_YAML" ]]; then
  echo "FATAL: lima yaml not found at $LIMA_YAML" >&2
  exit 1
fi

current_status="$(limactl list --json 2>/dev/null \
  | python3 -c "import json,sys
for line in sys.stdin:
    if not line.strip(): continue
    d=json.loads(line)
    if d.get('name')=='${LIMA_NAME}':
        print(d.get('status',''))
        break")" || true

if [[ "$current_status" == "Running" ]]; then
  echo "Lima VM '${LIMA_NAME}' already running."
  exit 0
fi

if [[ -n "$current_status" ]]; then
  echo "Lima VM '${LIMA_NAME}' exists (status: $current_status), starting..."
  limactl start "$LIMA_NAME"
else
  echo "Creating Lima VM '${LIMA_NAME}' from $LIMA_YAML"
  limactl start --name="$LIMA_NAME" --tty=false "$LIMA_YAML"
fi

echo
echo "Lima VM '${LIMA_NAME}' ready:"
limactl list "$LIMA_NAME"

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

# Run limactl start fully detached so it survives this shell's lifetime.
# Provision blocks (apt + cargo + nx) can take 15–30 min on first boot;
# the calling shell (or Claude's Bash tool, or a CI runner) might reap
# its children well before that, and that cascades a SIGTERM into Lima's
# hostagent and kills the VM mid-provision. Reparent to launchd (PID 1)
# via the subshell-orphan trick and tail the log via `make lima-tail-logs`
# or watch `make lima-status` until READY.
LOG="${TMPDIR:-/tmp}/lima-up-${LIMA_NAME}.log"
if [[ -n "$current_status" ]]; then
  echo "Lima VM '${LIMA_NAME}' exists (status: $current_status), starting (detached, log → $LOG)..."
  ( nohup limactl start "$LIMA_NAME" </dev/null >"$LOG" 2>&1 & )
else
  echo "Creating Lima VM '${LIMA_NAME}' from $LIMA_YAML (detached, log → $LOG)"
  ( nohup limactl start --name="$LIMA_NAME" --tty=false "$LIMA_YAML" </dev/null >"$LOG" 2>&1 & )
fi

# Give limactl a moment to register the instance, then surface state.
sleep 3
echo
echo "Lima VM '${LIMA_NAME}' state:"
limactl list "$LIMA_NAME" 2>&1
echo
echo "Provision is running in background. Watch with:"
echo "  tail -f $LOG"
echo "  make lima-tail-logs   # streams runner journal once unit exists"
echo "  make lima-status      # quick state"
echo
echo "Runner becomes ready when:"
echo "  limactl shell ${LIMA_NAME} sudo systemctl is-active boxlite-runner"
echo "returns 'active'. First-time provision typically 15-30 minutes."

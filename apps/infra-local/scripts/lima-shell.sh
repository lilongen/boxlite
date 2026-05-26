#!/usr/bin/env bash
# Open an interactive shell in the BoxLite Lima runner VM.
# Pass additional args through to `limactl shell` (e.g. `lima-shell.sh -- cmd`).
set -euo pipefail
LIMA_NAME="${LIMA_NAME:-boxlite-runner}"
exec limactl shell "$LIMA_NAME" "$@"

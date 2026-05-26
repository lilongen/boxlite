#!/usr/bin/env bash
# Stream boxlite-runner journalctl from inside the Lima VM.
set -euo pipefail
LIMA_NAME="${LIMA_NAME:-boxlite-runner}"
exec limactl shell "$LIMA_NAME" -- sudo journalctl -u boxlite-runner -f

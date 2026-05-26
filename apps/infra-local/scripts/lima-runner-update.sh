#!/usr/bin/env bash
# Pull latest main on the host, then lima-rebuild.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "== fetching latest main on host =="
git -C "$REPO_ROOT" fetch origin main
git -C "$REPO_ROOT" pull --ff-only origin main

echo "== rebuilding inside Lima =="
bash "$SCRIPT_DIR/lima-rebuild.sh"

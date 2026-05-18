#!/usr/bin/env bash
# One-time prep before first `docker compose up`.
#
# What it does:
#   1. Generates apps/yarn.lock (gitignored — every fresh clone needs it
#      so the API/snapshot-manager/proxy/ssh-gateway Dockerfiles can COPY it).
#   2. Copies .env.example -> .env if missing.
#   3. Validates the compose file.
#
# Idempotent. Safe to re-run.

set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

bold "1. Generate apps/yarn.lock (gitignored; required by Dockerfiles)"
if [ ! -s apps/yarn.lock ]; then
  ( cd apps && touch yarn.lock && yarn install >/dev/null 2>&1 )
  ok "yarn install -> apps/yarn.lock ($(wc -l < apps/yarn.lock) lines)"
else
  ok "apps/yarn.lock already exists ($(wc -l < apps/yarn.lock) lines)"
fi

bold "2. .env from template"
if [ ! -f apps/local-dev/.env ]; then
  cp apps/local-dev/.env.example apps/local-dev/.env
  ok "copied .env.example -> .env (edit it to override defaults)"
else
  ok ".env already present"
fi

bold "3. Validate docker-compose syntax"
docker compose -f apps/local-dev/docker-compose.local.yml \
  --env-file apps/local-dev/.env config --quiet >/dev/null
ok "docker-compose.local.yml parses cleanly"

bold "Ready. Bring the stack up with:"
echo "  docker compose -f apps/local-dev/docker-compose.local.yml --env-file apps/local-dev/.env up -d"
echo "Or full stack (proxy/ssh-gateway/snapshot-manager too):"
echo "  docker compose -f apps/local-dev/docker-compose.local.yml --env-file apps/local-dev/.env --profile full up -d"

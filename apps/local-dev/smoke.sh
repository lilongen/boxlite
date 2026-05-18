#!/usr/bin/env bash
# Local smoke test for the alpine:3.22.4 sandbox-creation fix.
#
# What this verifies (without booting the full API):
#   1. The compose stack is healthy (pg, redis, mock-runner).
#   2. The mock-runner rejects /snapshots/build (501) — confirms the routing
#      decision in our fix matters: any code path that still hits build will
#      fail visibly, not silently.
#   3. The mock-runner accepts /snapshots/inspect + /snapshots/pull — confirms
#      the snapshot.manager pull pipeline our fix routes to is reachable.
#   4. Postgres is ready to host the API's TypeORM migrations + state.
#
# What it does NOT verify (needs cloud or a heavier local API setup):
#   - The actual NestJS sandbox.service.createFromBuildInfo HTTP path.
#   - The full snapshot.manager state-machine transitions.
#   - End-to-end sandbox boot.

set -euo pipefail

cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

bold "1. Compose stack health"
docker compose -f docker-compose.local.yml ps --format '{{.Service}} {{.Status}}' | while read -r line; do
  case "$line" in
    *healthy*) ok "$line" ;;
    *) fail "not healthy: $line" ;;
  esac
done

bold "2. mock-runner refuses /snapshots/build (proves builds would be visible)"
status=$(curl -sS -o /tmp/build-resp.json -w '%{http_code}' -X POST \
  -H 'content-type: application/json' \
  -d '{"snapshot":"test/build","dockerfile":"FROM alpine"}' \
  http://localhost:3003/snapshots/build)
if [[ "$status" == "501" ]]; then
  ok "POST /snapshots/build -> 501 (with body: $(cat /tmp/build-resp.json))"
else
  fail "expected 501, got $status"
fi

bold "3. mock-runner serves /snapshots/inspect (the path snapshot.manager uses)"
inspect=$(curl -sS -X POST -H 'content-type: application/json' \
  -d '{"image":"alpine:3.22.4"}' \
  http://localhost:3003/snapshots/inspect)
echo "$inspect" | grep -q '"hash":"sha256:' && ok "got digest: $inspect" \
  || fail "no digest in response: $inspect"

bold "4. mock-runner accepts /snapshots/pull"
status=$(curl -sS -o /tmp/pull-resp.json -w '%{http_code}' -X POST \
  -H 'content-type: application/json' \
  -d '{"snapshot":"alpine:3.22.4"}' \
  http://localhost:3003/snapshots/pull)
[[ "$status" == "202" ]] && ok "POST /snapshots/pull -> 202" \
  || fail "expected 202, got $status"

bold "5. Postgres accepts a write/read round-trip"
docker exec boxlite-local-pg psql -U boxlite -d boxlite -tA -c \
  "CREATE TABLE IF NOT EXISTS smoke (t text); INSERT INTO smoke VALUES ('ok'); SELECT t FROM smoke;" \
  | tail -1 | grep -q '^ok$' && ok "pg write+read" || fail "pg round-trip"
docker exec boxlite-local-pg psql -U boxlite -d boxlite -c "DROP TABLE smoke;" >/dev/null

bold "6. Redis SET/GET round-trip"
docker exec boxlite-local-redis redis-cli SET smoke:test ok >/dev/null
[[ "$(docker exec boxlite-local-redis redis-cli GET smoke:test)" == "ok" ]] \
  && ok "redis set/get" || fail "redis round-trip"
docker exec boxlite-local-redis redis-cli DEL smoke:test >/dev/null

bold "All local infra checks passed."
echo
echo "Next steps for full verification:"
echo "  - Unit tests for the parser:  see apps/api/src/sandbox/utils/dockerfile.util.spec.ts"
echo "  - Service-level + UI smoke:   deploy this branch to dev.boxlite.ai"

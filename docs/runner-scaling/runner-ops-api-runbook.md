# Runner Ops API Runbook (curl)

> Current scope: **server-side wrapper + curl only**. The dashboard UI was
> deferred — see the status note in
> `docs/superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md`. A dedicated
> page will connect to these same endpoints later.

## What this is

Five admin-only HTTP endpoints in `apps/api` that wrap the validated
`apps/infra/lib/*-lib.ts` orchestration (add shared runner / scale-down runner).
They are the curl-hittable trigger for manual capacity operations and the
in-process actuation path a future autoscaler will reuse.

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/api/admin/runner-ops/shared` | List SHARED runners |
| POST | `/api/admin/runner-ops/add-shared` | Provision a SHARED runner (async job) |
| POST | `/api/admin/runner-ops/:runnerId/scale-down` | Drain + remove a SHARED runner (async job) |
| GET  | `/api/admin/runner-ops/jobs/:jobId` | Poll job status + progress lines |
| POST | `/api/admin/runner-ops/jobs/:jobId/cancel` | Cooperative cancel |

All require a platform-admin bearer token (`SystemActionGuard` +
`@RequiredApiRole([SystemRole.ADMIN])`). Add/scale-down return `202 { id }`
immediately; you then poll the job endpoint (the future UI does this every 2 s).

## Prerequisites

```bash
# apps/api running with the runner-ops config envs:
#   BOXLITE_RUNNER_OPS_API_URL        self-loopback base, e.g. http://localhost:3000
#   BOXLITE_RUNNER_OPS_ADMIN_TOKEN    admin API key used by the lib to self-call apps/api
#   BOXLITE_RUNNER_OPS_AWS_REGION     e.g. ap-southeast-1
#   BOXLITE_RUNNER_OPS_SUBNET_ID
#   BOXLITE_RUNNER_OPS_INSTANCE_PROFILE
#   BOXLITE_RUNNER_OPS_REGISTRY_URL
# Redis running (job store + locks). API process has AWS creds (EC2).

export API=http://localhost:3000          # or https://api.boxlite.test
export ADMIN_TOKEN='<admin-api-key>'      # startup log "Admin user created with API key:" or SST AdminApiKey
H=(-H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json')
```

Path note: the controller is mounted at `admin/runner-ops` and the API global
prefix is `api`, so the full path is `$API/api/admin/runner-ops/...`.

## List shared runners

```bash
curl -fsS "${H[@]}" "$API/api/admin/runner-ops/shared" | jq .
# 200 + { "runners": [ { id, name, regionId, state, availabilityScore, ... } ] }
# Negative test: drop the token or use a non-admin token -> 401/403.
```

## Add a shared runner (POST + poll)

`/tmp/test-add.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${API:?}"; : "${ADMIN_TOKEN:?}"
H=(-H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json')

JOB=$(curl -fsS "${H[@]}" -X POST "$API/api/admin/runner-ops/add-shared" \
  -d '{"name":"runner-entry-test-1","regionId":"us","instanceType":"c8i.2xlarge"}' \
  | jq -r .id)
echo "jobId=$JOB"

while true; do
  J=$(curl -fsS "${H[@]}" "$API/api/admin/runner-ops/jobs/$JOB")
  ST=$(echo "$J" | jq -r .status)
  echo "$J" | jq -r '.lines[-1] // "(no line)"'
  case "$ST" in
    SUCCESS) echo "OK"; echo "$J" | jq .result; break ;;
    FAILED)  echo "FAIL"; echo "$J" | jq .error;  break ;;
    STALE)   echo "STALE"; break ;;
  esac
  sleep 2
done
```

```bash
chmod +x /tmp/test-add.sh && API=$API ADMIN_TOKEN=$ADMIN_TOKEN /tmp/test-add.sh
```

## Scale down a shared runner

```bash
RUNNER_ID='<id from /shared>'

# Dry run -- preflight only, no side effects:
curl -fsS "${H[@]}" -X POST "$API/api/admin/runner-ops/$RUNNER_ID/scale-down" \
  -d '{"dryRun":true}' | jq .

# Real scale-down, then poll the returned job id like the add flow above:
JOB=$(curl -fsS "${H[@]}" -X POST "$API/api/admin/runner-ops/$RUNNER_ID/scale-down" \
  -d '{"restartStopped":false}' | jq -r .id)
```

## Concurrency lock (mechanism test, no AWS needed)

```bash
# Two adds at once: one 202, the other 409 (runner-ops:lock:add-shared).
curl -s "${H[@]}" -X POST "$API/api/admin/runner-ops/add-shared" -d '{"name":"a"}' &
curl -s -o /dev/null -w "%{http_code}\n" "${H[@]}" -X POST "$API/api/admin/runner-ops/add-shared" -d '{"name":"b"}'
```

## Minimal smoke (no AWS)

List (auth + routing) + the 409 lock test exercise controller -> service ->
Redis job -> lock -> poll without touching EC2. A no-AWS add still proves the
chain: the job moves to `RUNNING` then `FAILED` at the EC2 step, but the
entry-point mechanics are covered.

## Local provider (`provider=local`, no AWS) — full add + scale-down

`BOXLITE_RUNNER_OPS_PROVIDER=local` swaps EC2 for `LocalProcessInfraProvider`,
which spawns a native `boxlite-runner` per runner. This runs the **complete**
add + scale-down (including box migration) on a single host — used for the
2026-05-27 E2E (see [`local-scale-down-e2e-2026-05-27.md`](./local-scale-down-e2e-2026-05-27.md)
for the full walkthrough, build steps, and findings).

`apps/api/.env` for local:

```
BOXLITE_RUNNER_OPS_PROVIDER=local
BOXLITE_RUNNER_OPS_API_URL=http://localhost:3009        # NO /api suffix — the lib appends /api/admin/runners itself
BOXLITE_RUNNER_OPS_ADMIN_TOKEN=local-dev-admin-key
BOXLITE_RUNNER_OPS_LOCAL_RUNNER_BIN=/tmp/boxlite-runner-backup   # backup-capable runner (see E2E doc)
BOXLITE_RUNNER_OPS_LOCAL_HOME_ROOT=~/.blr               # keep SHORT — macOS SUN_LEN overflows on restore with a long root
BOXLITE_RUNNER_OPS_LOCAL_PORT_BASE=3100
BOXLITE_RUNNER_OPS_LOCAL_INSECURE_REGISTRIES=127.0.0.1:25000
BOXLITE_RUNNER_OPS_BACKUP_BUCKET=boxlite
BOXLITE_RUNNER_OPS_BACKUP_ENDPOINT=http://127.0.0.1:29000
BOXLITE_RUNNER_OPS_BACKUP_REGION=us-east-1
BOXLITE_RUNNER_OPS_BACKUP_ACCESS_KEY=minioadmin
BOXLITE_RUNNER_OPS_BACKUP_SECRET_KEY=minioadmin
# BOXLITE_RUNNER_OPS_LOCAL_DYLD intentionally unset — the runner statically links libboxlite
```

Add-via-wrapper flow (same endpoints as the AWS path, no AWS creds):

```bash
TOK=local-dev-admin-key; API=http://localhost:3009
# add a runner; the provider spawns boxlite-runner on PORT_BASE+ and writes ~/.blr/<id-prefix>/meta.json
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
     -d '{"name":"e2e-runner-a","regionId":"us"}' "$API/api/admin/runner-ops/add-shared"
# poll the returned job id until status=SUCCESS (→ runner READY), then scale-down as in the AWS flow.
```

Two config gotchas the AWS path doesn't hit: the `/api`-suffix rule on
`*_API_URL` and the short `*_HOME_ROOT` requirement. Both are detailed in the
E2E doc's Findings.

## CLI equivalents

The same libs back two CLIs (identical behaviour, no HTTP):

```bash
cd apps/infra
BOXLITE_ADMIN_API_KEY=<token> AWS_PROFILE=<...> npx tsx scripts/add-shared-runner.ts --name <...> --yes
BOXLITE_ADMIN_API_KEY=<token> AWS_PROFILE=<...> npx tsx scripts/scale-down-runner.ts --id <id> --yes
```

## Audit + limits

- Audit entries via `AuditModule`; job records in Redis under `runner-ops:job:` (TTL 24h).
- One concurrent add + one concurrent scale-down platform-wide (Redis locks).
- No autoscaling (manual trigger only). No CUSTOM runner support (use `add-runner.ts`).
- Foundation gaps on this branch (jest preset, api-client regen, dashboard tsc
  base config) are tracked in `docs/follow-ups/jest-infra-restore.md`.

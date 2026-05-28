# Runner-Ops API-Endpoint E2E — add + scale-down (real AWS) — 2026-05-28

Validates the **runner-ops REST endpoints** (`RunnerOpsController`:
`POST /api/admin/runner-ops/add-shared`, `POST /api/admin/runner-ops/:id/scale-down`,
job polling) end to end against real dev AWS — the endpoints the **deployed** dev
API does not have (it predates `RunnerOpsController` → `404`). Complements the
CLI-path migration run in [aws-migration-e2e-2026-05-28.md](./aws-migration-e2e-2026-05-28.md)
(which drives the same `apps/infra/lib` orchestration without the HTTP/job-store
wrapper).

## Why an in-VPC API box

The deployed dev API can't serve these endpoints, and a laptop can't reach dev's
private RDS/Redis or be reached by EC2 runners. So the **current-tree `apps/api`**
(which *has* `RunnerOpsController`) was built and run on a throwaway EC2 **inside
the dev VPC** (`i-075a4942e1b742a6c`, `10.0.1.93:3000`, SG `sg-036765d8c5296e1f0`).
The API is VPC-private, so all calls are driven via SSM `curl localhost:3000` on
that box. Provider = `aws`; runners pull the fork backup-capable release
(`BOXLITE_RUNNER_RELEASE_REPO=lilongen/boxlite`, `v0.9.6`). Scoped IAM:
`boxlite-e2e-api-role` (ec2 run/terminate/describe + `iam:PassRole` RunnerRole +
ecs:Describe* + S3 backups).

Two control-plane tiers were tested:

| Tier | DB / Redis | Crons | Use |
| --- | --- | --- | --- |
| **A** | **shared** dev RDS/Redis | OFF (avoid double-cron) | add + empty scale-down |
| **B** | **own** local pg/redis (isolated) | ON (sole controller) | full live-box migration |

## Results

**Headline: `add-shared`, `scale-down`, and `scale-down` with live box migration
all PASS via the API endpoints.** The migration was proven on the isolated B-tier
(the final, correct setup). An earlier A-tier attempt couldn't host the migration
*test* — but that is a property of the shared-DB test setup, **not** the feature
and **not** production (see the note after the table).

| Test (via API endpoint) | Tier | Result |
| --- | --- | --- |
| `add-shared` → job → runner READY | A | ✅ PASS — 7-stage job; runner `3b42a723…` provisioned (fork v0.9.6) + heartbeated to the in-VPC API → READY |
| `scale-down` of an **empty** runner | A | ✅ PASS — 10-stage job; row deleted + EC2 terminated; `GET …/runners/:id → 404` |
| `add-shared` ×2 + place 4 boxes | B | ✅ PASS — r1/r2 added via API; 2 boxes each placed via `/api/sandbox`, all STARTED and **stayed** started |
| **`scale-down` r1 with live box migration** | **B** | ✅ **PASS** — all 10 stages incl. the migration leg (below) |
| (same migration, first attempted on A) | A | ⚠️ not runnable on A — the shared-DB **test setup** errors the boxes before migration; a test-setup artifact, not a feature/prod defect. This is what drove the switch to B. See note. |

### B-tier migration job (the full path) — all 10 stages

```
[1] Preflight: peer pool = r2 (only ready+schedulable peer)
[2] Cordon source (r1)
[3] Enumerate: started=2  ← boxes STAYED started (no recreate race on isolated DB)
[4] Stop 2 STARTED        → ✓ STOPPED
[5] Ensure backup         → ✓ COMPLETED (Box.Export → S3)
[6] Archive               → ✓ runnerId=null
[7] Restart on peer       → ✓ STARTED on r2 (sandbox.id preserved)
[8] Drain wait            → source has 0 non-archived/destroyed
[9] DELETE runner row     → ✓
[10] Terminate host       → ✓ EC2 terminated
```

So **add + scale-down + live migration all work through `/api/admin/runner-ops/*`**
on the current tree, with the Redis job store + platform lock + async 202→poll
surface that the CLI path bypasses.

## Note: why the migration test can't run on A-tier (a test-setup limitation, not a product/prod issue)

**This is not a defect in scale-down/migration, and it does not happen in
production.** It is purely an artifact of the A-tier *test shortcut* — running a
**second** API against the **same** dev database. Production (and B-tier) have a
**single** API → a single controller → none of this occurs. The migration feature
is proven by the B-tier run above (and by the CLI path in
[aws-migration-e2e-2026-05-28.md](./aws-migration-e2e-2026-05-28.md)).

What happened on A-tier: the 4 placed boxes reached STARTED, then **all flipped to
`error`** (`box with name '…' already exists (code=5)`) *before* the scale-down's
stop stage. Scale-down then saw `started=0 skipped(error)=2 → nothing to migrate`,
stage-8 drain timed out, stage-9 `DELETE → 428` → job FAILED.

Root cause = **dual-controller race**: on A-tier two controllers share one DB — my
in-VPC API (doing the scale-down) **and** the always-on **deployed dev API**, whose
`sync-states` cron re-issues `CREATE_SANDBOX` for boxes it didn't create → the
runner rejects the duplicate → `error`. I can't disable the prod-dev crons, and two
controllers on one DB inherently conflict — hence "structural" *for that setup*.
(`add` + *empty* scale-down work on A-tier because they have no box lifecycle to
race over.)

**Resolution = B-tier (isolated control plane):** the in-VPC API gets its own
Postgres+Redis with crons ON, so it is the **sole** controller and drives the box
state machine coherently → migration succeeds (above). It shares only AWS-level
(EC2 / S3 backups / snapshot registry); the dev DB and the real `default` runner
are never touched.

> Distinct, *production-relevant* item (single-API, not this dual-controller
> artifact): the `sync-states` reconcile can re-create a **bystander** box under
> heavy migration load — tracked separately in
> [runner-migration-bystander-recreate-race.md](../follow-ups/runner-migration-bystander-recreate-race.md).

## Steps & commands (driven via SSM `curl localhost:3000` on the API box)

```bash
ADMIN=$(jq -r '.[]|select(.name=="ADMIN_API_KEY").value' /tmp/env.json)   # dev admin, from ECS task-def
API=http://127.0.0.1:3000

# add a runner (async job)
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"regionId":"us","instanceType":"c8i.large","timeoutSec":480}' \
  "$API/api/admin/runner-ops/add-shared"           # → {id}
curl -s -H "Authorization: Bearer $ADMIN" "$API/api/admin/runner-ops/jobs/$id"  # poll → SUCCESS, result.runnerId

# (cordon the new runner immediately — it is a schedulable row)
curl -s -X PATCH -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"unschedulable":true}' "$API/api/admin/runners/<runnerId>/scheduling"

# scale down (async job)
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{}' "$API/api/admin/runner-ops/<runnerId>/scale-down"   # → {id} → poll jobs/:id
```

### B-tier prerequisites (fresh isolated DB)

Box create needs **three** seeded tables (else `400 "Snapshot … not available in
region us"` or scheduler finds no runner):
- `snapshot` — clone an active dev snapshot row, re-home `organizationId` to the
  local admin org (its `ref` still points at the shared dev registry image).
- `snapshot_region` — `(snapshotId, regionId='us')`. **No `id` column**; PK is
  `(snapshotId, regionId)`. This is the row `isAvailableInRegion` checks.
- `snapshot_runner` — `(runnerId, snapshotRef, state='ready')` per runner.

Plus: local pg role (SUPERUSER) + `RUN_MIGRATIONS=true` (creates schema),
`DISABLE_CRON_JOBS=false`, point `DB_*`/`REDIS_*` at localhost, and suppress the
phantom default with `DEFAULT_RUNNER_NAME=` empty.

## Environment / IDs

- AWS `michaelli` (`064212132677`, `ap-southeast-1`). API EC2
  `i-075a4942e1b742a6c` (`10.0.1.93:3000`), `PORT=3000`.
- A-tier: runner `3b42a723…` (added+scaled-down). r1 `3a25f5f3…`, r2 `d5b7511e…`
  (migration attempt, failed, cleaned).
- B-tier: r1 `2664bd1f…`, r2 `baca8a85…`; migrated boxes `16b84ad6…`,`af95183a…`
  (r1→r2). All test runners/boxes torn down; **API EC2 kept** for further runs.

## Build/run gotchas (in-VPC API)

- Bare root `/opt/boxlite/package.json` (no workspaces) makes yarn-4 reject
  `apps/` → `rm` it before `corepack yarn install`.
- snap `aws-cli` writes **0 bytes on direct `> file`** → pipe through `| cat`.
- `release` event runs the workflow file from the default branch (unrelated to
  this run but noted in the release follow-up).

## Status

- ✅ **add + scale-down via the API endpoints proven** against real AWS.
- ✅ **full live-box migration via the API endpoint proven** (B-tier, isolated):
  the complete add → place → migrate → scale-down → terminate path works through
  `/api/admin/runner-ops/*`.
- ℹ️ Test-setup note (**not** a feature or production limitation): don't run a
  second API against the shared dev DB — use an isolated control plane (B-tier)
  for any test that exercises box lifecycle/migration. Production runs a single
  API, so the dual-controller race can't occur there.

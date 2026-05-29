# Runner-Ops API-Endpoint E2E — round-2 review fixes — 2026-05-29 (real AWS)

Re-run of the runner-ops API-endpoint E2E to validate the round-2 review fixes
landed in `fix(runner-ops): address round-2 review findings` (integration
`2975cae7`). Complements the original proof in
[api-endpoint-e2e-2026-05-28.md](./api-endpoint-e2e-2026-05-28.md); same in-VPC
B-tier setup (isolated control plane), same `/api/admin/runner-ops/*` surface.

## What this run validates

| # | Fix | How it was exercised | Result |
| --- | --- | --- | --- |
| 1 | **Runner apiKey never persisted in full** to the Redis job record | `GET /jobs/:id` after `add-shared` | ✅ `result.apiKey = "dtn_…8e97"` — masked prefix…suffix, not the live key |
| 2 | **Cooperative cancel is real** (was an inert flag) | `POST /add-shared` then immediate `POST /jobs/:id/cancel` | ✅ `RUNNING → CANCEL_REQUESTED (s3) → CANCELLED (s4)`; **no EC2 provisioned** (abort fired at the stage-4 `checkAborted`, before `RunInstances`) |
| 3 | **Platform lock renewed per stage** so a long op can't lose it mid-flight | 10-stage `scale-down` with live migration | ✅ ran clean through all 10 stages (heartbeat renews on each progress event) |
| — | **No regression** to add / scale-down / live migration happy path | full add ×2 + place ×2 + scale-down-with-migration | ✅ all PASS via the endpoints |

## Full flow (all via `POST/GET /api/admin/runner-ops/*`)

```
add-shared r1  → job SUCCESS → runner e8980a96 READY (fork v0.9.6, region us)
add-shared r2  → job SUCCESS → runner 408a2683 READY  (migration peer)
place 2 boxes on r1 (r2 cordoned to steer scheduling) → both STARTED and STAYED started
scale-down r1  → job SUCCESS @ stage 10:
   [2] cordon r1  [4] stop 2 boxes  [5] backup (Box.Export→S3)  [6] archive
   [7] restart on r2  [8] drain  [9] DELETE r1 row  [10] terminate r1 EC2
final: e2e-box-1 + e2e-box-2 STARTED on r2 (408a2683); r1 row gone; r1 EC2 terminated
```

So **add + add + place + scale-down-with-live-migration all PASS** on the current
tree with the fixes, plus the cancel and masked-apiKey behaviours above.

## Setup (B-tier isolated control plane)

- In-VPC API box `i-075a4942e1b742a6c` (`10.0.1.93:3000`), rebuilt from integration
  `2975cae7`: `corepack yarn install` + `nx build api` → `node dist/apps/api/main.js`.
- Env reconstructed **on the box** from the dev Api ECS task-def (`...-Api:55`) so
  secrets never left it, with B-tier overrides: `DB_*`/`REDIS_*` → localhost
  (local Postgres+Redis), `DISABLE_CRON_JOBS=false` (sole controller),
  `DEFAULT_RUNNER_NAME=` empty.
- runner-ops config: `PROVIDER=aws`, `API_URL=http://10.0.1.93:3000`,
  `SUBNET_ID=subnet-0fdf9e1fd142ac7cc`, `INSTANCE_PROFILE=RunnerProfile-434704b`,
  `REGISTRY_URL=<dev internal registry>`, `BACKUP_BUCKET=boxlite-volume-backups-dev`,
  `RELEASE_REPO=lilongen/boxlite`, `VERSION=0.9.6`, `CARGO_TOML=/opt/boxlite/Cargo.toml`.
- Shares only AWS-level resources (EC2 / S3 backups / snapshot registry); the dev
  DB and the real `default` runner are never touched.

## Two config notes (setup, not code defects)

- `BOXLITE_RUNNER_OPS_API_URL` must be the box's **routable private IP**
  (`http://10.0.1.93:3000`), not `127.0.0.1`. The lib bakes this into the runner's
  `BOXLITE_API_URL`, so a loopback value leaves the runner unable to heartbeat →
  it never reaches READY. (A first add with `127.0.0.1` reproduced this: runner row
  stuck `initializing`, empty `apiUrl`.)
- `AwsInfraProvider` requires `BOXLITE_RUNNER_OPS_CARGO_TOML` (repo-root Cargo.toml);
  `BOXLITE_RUNNER_VERSION` still takes precedence for the actual release download.

## IDs / cleanup

- Runners: r1 `e8980a96` (added + scaled-down/terminated), r2 `408a2683` (peer;
  EC2 terminated in cleanup). Boxes `3cb17112`, `f5354a3e` (r1→r2 migrated).
  Cancel job `01KSS02FCC3EMXPZKNMA1G97PN` (no EC2). One earlier `127.0.0.1` runner
  (`df3e4ad4`) torn down.
- All test runners/boxes removed, local DB wiped. Real `default`/`prod` runners and
  the dev DB untouched. In-VPC API box **stopped** (preserved for future runs).

## Status

✅ All three round-2 fixes (#1 masked apiKey, #2 real cancel, #3 lock renewal) and
the full add→place→migrate→scale-down path are proven through `/api/admin/runner-ops/*`
on real dev AWS. Matches the unit coverage (18/18 jest incl. cancel regression +
masked-apiKey assertion + `renewLock` owner-only) and the Go `isBackupRef` test.

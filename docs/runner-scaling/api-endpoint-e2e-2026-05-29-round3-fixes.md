# Runner-Ops API-Endpoint E2E — round-3 + follow-up fixes — 2026-05-29 (real AWS)

Second 2026-05-29 pass, re-running the runner-ops API-endpoint E2E to validate
the round-3 + medium + nit fixes (integration `0d4dba03`). Same in-VPC B-tier
setup as [api-endpoint-e2e-2026-05-29-review-fixes.md](./api-endpoint-e2e-2026-05-29-review-fixes.md)
(isolated local pg/redis, crons on, all calls via SSM `curl localhost:3000`).

## What this run validated

| Fix | Check | Result |
| --- | --- | --- |
| **N3** runnerId validation | `POST /:id/scale-down` with a non-UUID id | ✅ 400 (ParseUUIDPipe rejects at the boundary) |
| **PR2#5** real instance id | `add-shared` job result | ✅ `ec2InstanceId: i-08e831790a65768e9` (real id), `privateIp: 10.0.0.67` (IP separated); was the IP before |
| **C1** scale-down secret masking | scale-down job result | ✅ `peers: [{id,name,region}]` (no apiKey), **no `sourceApiKey`** — fleet-wide key leak gone |
| **PR2#3** migration-failure surfacing | scale-down result fields | ✅ `migrationFailures: []`, `runnerRowDeleted: true`, `sandboxesMigrated:[2]`, `sandboxesArchived:[]` |
| **PR2#4 + M2** orphan cleanup on cancel | cancel after the runner row is created | ✅ `CANCELLED` + `cleanup: deleted orphan runner row …` → DB row count **0**, no leaked EC2 |
| no-regression (H1/H2/PR2#1) | full add+add+place+scale-down+migration | ✅ all PASS; 10-stage scale-down ran clean with the background heartbeat |

## Full flow (all via `/api/admin/runner-ops/*`)
```
add r1 → READY (a2500225, EC2 i-08e831790a65768e9)
add r2 → READY (70057331, migration peer)
place 2 boxes on r1 (r2 cordoned) → both STARTED
scale-down r1 → SUCCESS @ stage 10: both boxes migrated to r2, r1 row deleted, r1 EC2 terminated
cancel an add after row creation → CANCELLED + orphan row cordoned & deleted (count 0), no EC2
```

## Timeline & phase timings (UTC, 2026-05-29)

| Time (UTC) | Milestone |
| --- | --- |
| 07:31:43 | add **r1** → EC2 launched (`i-08e831790a65768e9`) |
| 07:32:40 | **r1 READY** (~57 s from EC2 launch) |
| 07:33:06 | add **r2** → EC2 launched (`i-0f8d831623880c17c`) |
| 07:33:55 | **r2 READY** (~49 s) |
| 07:34:16–07:34:22 | 2 boxes placed on r1 |
| 07:34:38 | both boxes **STARTED** |
| 07:35:24 → 07:35:44 | **scale-down r1** running → **SUCCESS** (stage 10) |
| 07:36:34 | cancel #1 → CANCELLED, but cleanup DELETE **428** (bug surfaced) |
| 07:42:03 | cancel #3 (after row created) still 428 — nx cache masking the lib fix |
| 07:44:20 | cancel #4 (after clean rebuild) → CANCELLED + **orphan row deleted (count 0)**, no EC2 ✅ |

Main phase durations (wall clock):

- **add runner (provision → READY):** r1 **~57 s**, r2 **~49 s** (EC2 launch →
  runner heartbeat ready; fork v0.9.6 boot + register). Adds are serialized by
  the one-concurrent-add platform lock, so r1 then r2.
- **box placement → STARTED (2 boxes):** **~16–22 s**.
- **scale-down + live migration (10 stages):** **~40 s** (job-measured
  `durationMs: 39891` — cordon → stop → backup (`Box.Export`→S3) → archive →
  restart-on-peer → drain → DELETE row → terminate host).
- **cancel → CANCELLED (+ orphan cordon+delete):** **~2 s**.

(End-to-end the runner ops above span ~07:31–07:36; 07:36–07:44 is the
cancel-cleanup bug fix + clean-rebuild re-validation.)

## Bug found by this E2E (and fixed): orphan-cleanup DELETE needed a cordon

The first cancel run exposed that the PR2#4/M2 cleanup's `DELETE /api/admin/runners/:id`
returned **428 "available for scheduling"** — the runner row is created schedulable,
and `RunnerService.remove` rejects deletion of a schedulable runner. The cleanup
logged-but-did-not-remove the orphan. **Fix (`0d4dba03`):** cordon
(`PATCH /scheduling {unschedulable:true}`) before `DELETE` in the add cleanup,
the same order scale-down uses (added `PATCH` to the lib's `apiFetch` union).

Re-validation also surfaced an **nx build gotcha**: `nx build api` does not track
the relative-imported `apps/infra/lib/*` as a build input, so the lib-only fix
hit a **cache hit** and served the stale bundle (still 428). Rebuilding with
`nx reset && nx build api --skip-nx-cache` deployed the fix; the cancel-after-row
test then showed the orphan row deleted (count 0). (Earlier C1/PR2#5/PR2#3
results stand — that build was at `4801fb1b`, where api source changed, so the
cache invalidated normally.)

## Cleanup
All test runners terminated (r1 by scale-down, r2 + cancel attempts), local DB
wiped, in-VPC API box stopped. Real `default`/`prod` runners and the dev DB never
touched (B-tier isolation).

## Status
✅ All round-3 + medium + N2/N3/N6 fixes validated end-to-end on real dev AWS,
plus the cordon-before-delete fix this run surfaced (orphan-cleanup 428 +
nx-cache gotcha). A clean from-scratch confirmation re-run — every step green, no
detours — is reported separately in
[api-endpoint-e2e-2026-05-29-confirmation-run.md](./api-endpoint-e2e-2026-05-29-confirmation-run.md).
Matches the unit coverage (api runner-ops 20/20, infra lib 7/7).

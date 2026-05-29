# Runner-Ops API-Endpoint E2E — clean confirmation re-run — 2026-05-29 (real AWS)

A from-scratch re-run of the full runner-ops API-endpoint pipeline to confirm
**every step passes cleanly** after the round-3 + follow-up fixes (including the
cordon-before-delete orphan-cleanup fix). This is the **clean-green** counterpart
to the bug-finding run in
[api-endpoint-e2e-2026-05-29-round3-fixes.md](./api-endpoint-e2e-2026-05-29-round3-fixes.md)
— that run found and fixed the orphan-cleanup 428 + the nx-cache gotcha; this run
just confirms the result with no detours.

Same in-VPC **B-tier** setup (isolated local pg/redis on the API box, crons on,
all calls via SSM `curl localhost:3000`). Driven by one scripted run with
per-assertion PASS/FAIL.

**Prereq:** a clean build so the infra-lib fix is actually bundled —
`nx reset && nx build api --skip-nx-cache` (nx does not track the
relative-imported `apps/infra/lib/*` as an api-build input, so a lib-only change
otherwise hits a stale cache hit).

## Result: happy path 15/15 PASS, 0 FAIL; cancel + orphan cleanup PASS first try — no detours

| Assertion group | Result |
| --- | --- |
| STEP1 auth + N3 | list=0 ✓, noauth=401 ✓, non-UUID scale-down=400 ✓ |
| STEP2 add r1 | SUCCESS ✓, `ec2InstanceId=i-03ac01d667c38d1cc` (real id) ✓, apiKey `dtn_…c5d9` masked ✓ |
| STEP3 add r2 | SUCCESS ✓ |
| STEP4 place 2 boxes | both scheduled on r1 ✓, both STARTED ✓ |
| STEP5 scale-down r1 + migrate | SUCCESS ✓, `migrationFailures=[]` ✓, `runnerRowDeleted=true` ✓, r1 row deleted ✓, both boxes migrated to r2 (started) ✓ |
| STEP6 cancel after row created | CANCELLED ✓, orphan row cordoned+deleted (count 0) ✓, no leaked EC2 ✓ |

## Timeline (UTC, 2026-05-29)

| Time | Milestone |
| --- | --- |
| 08:05:52 | add r1 → EC2 launched (`i-03ac01d667c38d1cc`, runner 88c7fe9b) |
| 08:06:42 | **r1 READY** |
| 08:06:43 | add r2 → EC2 launched (runner 174cd6a3) |
| 08:07:32 | **r2 READY** |
| 08:07:32–08:07:39 | 2 boxes placed on r1 → both **STARTED** |
| 08:07:39 → 08:08:29 | **scale-down r1** running → **SUCCESS** (live migration to r2) |
| 08:09:03 → 08:09:05 | **cancel** after row created → **CANCELLED** + orphan row deleted (count 0) |

## Main phase durations (wall clock)

- **add runner (provision → READY):** r1 **~50 s** (08:05:52→08:06:42), r2 **~49 s**
  (08:06:43→08:07:32). Serialized by the one-concurrent-add lock.
- **place 2 boxes → STARTED:** **≤~7 s** (within the 08:07:32–08:07:39 window;
  libkrun microVM boot — per-box boot not separately logged this run).
- **scale-down + live migration (10 stages):** **~50 s** (08:07:39→08:08:29).
- **cancel → CANCELLED (+ orphan cordon+delete):** **~2 s** (08:09:03→08:09:05).
- (Prereq: clean `nx build api --skip-nx-cache` before the run.)

## Cleanup
All test runners terminated (r1 by scale-down, r2 + cancel attempts), local DB
wiped, in-VPC API box stopped. Real `default`/`prod` runners and the dev DB never
touched (B-tier isolation).

## Status
✅ Clean from-scratch re-run passed every step (happy path 15/15 + cancel/orphan)
with no detours, confirming the round-3 + follow-up fixes end to end on real dev
AWS. Matches the unit coverage (api runner-ops 20/20, infra lib 7/7).

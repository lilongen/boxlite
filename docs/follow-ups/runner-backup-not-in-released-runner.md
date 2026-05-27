# Follow-up: box migration blocked — released runner lacks backup support

**Filed:** 2026-05-27
**Surfaced by:** Real-AWS box-migration E2E on dev.boxlite.ai (goal: validate scale-down with live box migration)
**Owner:** TBD
**Priority:** High for shipping runner auto-scaling — scale-down **with boxes** cannot migrate until a backup-capable runner is released.

## Symptom

Scaling down a SHARED runner that hosts started boxes aborts at the backup stage:

```
[5/10] Ensure backup COMPLETED for N sandbox(es)
   <id> … status=triggered → backup ended in ERROR; retrying once → FAIL; aborting
```

Runner-side log (SSM into the EC2 runner, `journalctl -u boxlite-runner`):

```
WRN create backup not yet implemented in BoxLite  sandbox=<id>
ERR Job failed  job_type=CREATE_BACKUP  error="backup is not supported by the BoxLite Go SDK"
```

## Root cause

The **GitHub-release runner binary** (`boxlite-runner-v0.9.5-linux-amd64`, fetched by
the EC2 user-data) ships a **stub** for `CREATE_BACKUP` that returns "not yet
implemented / backup is not supported by the BoxLite Go SDK".

The actual in-process backup (export the box via the Go SDK `Box.Export` →
`boxlite_box_export`, upload the `.boxlite` archive to S3) lives in **this tree's**
[`apps/runner/pkg/boxlite/stubs.go`](../../apps/runner/pkg/boxlite/stubs.go)
(`CreateBackup`) — the same code that the local E2E exercised with a
purpose-built backup-capable runner. It is **not in the released artifact**.

So the migration leg of scale-down (`stop → backup → archive → restore-on-peer`)
cannot complete on dev: the released runner never produces the backup archive.

## What DID work (so the gap is narrow)

The real-AWS run validated everything up to the runner-side backup:
- `AwsInfraProvider` provision/terminate on real EC2 (c8i.large, nested-virt) ✓
- Box **placement control via cordon** — created s11,s12 on r1 and s21,s22 on r2
  exactly as intended, never on dev's `default` (cordoned for the window, then
  restored) ✓
- scale-down orchestration stages 1–4 (preflight, peer-pool=our r2 only, cordon
  source, stop boxes) ✓
- It only fails at stage 5 (backup), purely because the runner binary lacks the
  implementation.

## Required infra for backup/migration (verified)

- Runner must be launched with `--with-backup-sidecar --backups-bucket <bucket>`
  (sets `BOXLITE_BACKUPS_BUCKET`); without it `CreateBackup` errors "bucket not set".
- The bucket must match the RunnerRole S3 policy `arn:aws:s3:::boxlite-volume-*`
  (sst.config.ts). Dev has **`boxlite-volume-backups-dev`** for this.
- AND the runner binary must actually implement backup (this is the blocker).

## Fix / next step

Build + release a **backup-capable runner** (the `apps/runner` in this tree already
has the implementation; the released v0.9.5 does not). Once a backup-capable
`boxlite-runner-<ver>-linux-amd64` is published, the EC2 user-data will fetch it
and the migration E2E can be re-run. Until then, **scale-down auto-migration of
live boxes is not production-ready on AWS** (empty-runner scale-down + provision/
terminate ARE proven; box migration is proven only on the local provider with a
locally-built backup runner).

## Test-environment note (rules honored)

The dev `default` runner was only ever **cordoned** (reversible scheduling flag)
during the placement/migration window and **restored to `unschedulable=false`**
afterward; its EC2/lifecycle was never touched. All test runners/boxes/EC2 were
created by the test and fully cleaned up.

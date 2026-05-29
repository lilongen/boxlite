# Follow-up: migration onto a busy peer can flip its bystander boxes to `error`

**Filed:** 2026-05-28
**Surfaced by:** Real-AWS scale-down + live migration E2E
([aws-migration-e2e-2026-05-28.md](../runner-scaling/aws-migration-e2e-2026-05-28.md))
**Owner:** TBD
**Priority:** Medium — does not affect scale-down correctness, but could disrupt
live boxes already running on the migration-target peer in production.

## Symptom

During a scale-down that migrates r1's boxes onto peer r2, the **pre-existing**
boxes on r2 (not part of the migration) flipped from `started` to `error`:

```
errorReason = failed to create box: boxlite: invalid argument:
              box with name '<sandbox-id>' already exists (code=5)
```

Runner journal (r2), all within ~10s of the migration's backup/restore activity:

```
05:23:42  s21/s22 CREATE_SANDBOX completed → started   (placed normally)
05:25:10  CREATE_BACKUP issued for s21 AND s22
05:25:20  CREATE_SANDBOX issued AGAIN for s21/s22 → ERR "already exists (code=5)"
05:25:45  (separately) scale-down's restore of the migrated boxes completes OK
```

## Root cause (hypothesis, evidence-backed)

`scale-down-runner.ts` only enumerates/operates on the **source** runner's boxes
— it never issues jobs for a peer's own boxes. So the redundant
`CREATE_BACKUP` + `CREATE_SANDBOX` on the r2 bystanders came from the **API's
periodic reconciliation crons** (enabled on dev), racing the migration:

- [`sandbox.manager.ts` `sync-states`](../../apps/api/src/sandbox/managers/sandbox.manager.ts#L678)
  (EVERY_10s) reconciles desired vs. runner-reported state and calls
  [`runnerAdapter.createSandbox(...)`](../../apps/api/src/sandbox/managers/sandbox.manager.ts#L599)
  when it believes a desired-`started` box is absent on its runner.
- [`backup.manager.ts` `sync-stop-state-create-backups`](../../apps/api/src/sandbox/managers/backup.manager.ts#L325)
  (EVERY_10s) drives backups.

Under the concurrent backup(export)+restore(import) load of a co-located
migration, the runner's state report (sandbox-sync → `ListInfo`, every 10s) lags
or transiently mis-reports the bystander boxes, the reconciler concludes they
need (re)creation, and the runner correctly rejects the duplicate with
`already exists`. The box is then marked `error`. This is consistent with the
known sandbox-sync/`ListInfo` instability
([runner-listinfo-cgo-crash.md](./runner-listinfo-cgo-crash.md)).

NOT reproduced as a scale-down/provider defect; the migration of the source
boxes itself succeeded (identity preserved, started on the peer).

## Suggested fix (to verify)

Make the reconcile create path **idempotent**: in `runnerAdapter.createSandbox`
(or the `sync-states` caller), treat the runner's `already exists (code=5)`
response as success — the box is present, which is the desired state — instead
of letting the job fail and marking the sandbox `error`. Optionally debounce
`sync-states` re-create when the runner has in-flight backup/restore jobs for
other sandboxes (state report is known-stale then).

A reproduction test should drive a `sync-states` pass against a runner whose
reported state omits a started box that actually exists, and assert the sandbox
stays `started` (not `error`).

## Impact / workaround

- In the E2E the affected boxes were the operator's own test boxes; no real
  workload was harmed and they were recoverable (`backupState=Completed`).
- Until fixed, prefer migrating onto a peer with spare headroom and avoid
  co-locating heavy migrations with other live boxes on a small (2-vCPU) runner.

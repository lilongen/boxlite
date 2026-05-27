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

### Precise root cause (why it "worked on feat" but not now) — NOT a regression

- Real `CreateBackup` was added by commit **`9528cf5e` "feat(runner): in-process
  CreateBackup + restore via FFI + S3" (2026-05-22)**, which replaced the old
  `"create backup not yet implemented"` stub in `stubs.go`.
- The dev runner's log emits exactly `"create backup not yet implemented in
  BoxLite"` — **a string that no longer exists anywhere in the current source**
  (`git grep` finds only other stubs: remove-image, build-snapshot, …). ⇒ the
  running dev binary was compiled from **pre-`9528cf5e`** source.
- The dev runner is **not built from source**: `add-shared-runner-dev.sh`'s EC2
  user-data `curl`s the prebuilt `boxlite-runner-v0.9.5-linux-amd64` release
  asset. That asset was produced by `build-runner-binary.yml` **before** backup
  landed and was **never re-cut**, so it carries the stub.
- `integration` HAS the backup code (`9528cf5e` is in HEAD) **and** the wiring
  (`apps/runner/go.mod` `replace …/sdks/go => ../../sdks/go`, commit `9ae01512`),
  so building the runner **from current source** yields backup (proven: the local
  E2E's `/tmp/boxlite-runner-backup`).
- **Why feat appeared to work:** the feat e2e harness
  `apps/infra/scripts/test-setup-scale-down.ts` does **not** deploy a custom
  runner binary (it only SSM-rewrites `INSECURE_REGISTRIES` + restarts). So feat's
  passing backup ran against a runner whose binary had been **manually/locally
  built (backup-capable) and deployed during feat development** — not the released
  asset. The plain `add-shared-runner-dev.sh` flow pulls the stale release, so the
  difference is purely *which binary the EC2 ended up running*, not an integration
  regression.

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

## Fix — 正路 (re-cut the runner release from current source)

The runner release is a **two-stage chain** (`build-runner-binary.yml`): it
downloads the prebuilt **`boxlite-c-v<ver>-linux-x64-gnu`** archive (→
`sdks/go/libboxlite.a`, which must export `boxlite_box_export`) and `go build`s
`./runner/cmd/runner` linking that lib + the in-repo `sdks/go` (which provides
`Box.Export`). Both halves are backup-capable in the current source, so a fresh
release fixes it:

1. **Pick a new version** in `Cargo.toml` (e.g. bump to the next patch). Re-using
   `0.9.5` would overwrite the stale assets in place — a clean bump is less
   confusing since `RUNNER_VERSION` (and thus the user-data download URL) is
   derived from `Cargo.toml`.
2. **Re-cut the C SDK** first: run the **"Build C SDK"** workflow at that version
   so `boxlite-c-v<ver>-linux-x64-gnu` (libboxlite.a) is published. The current C
   SDK exports `boxlite_box_export` / `boxlite_runtime_import_box` (verified:
   `nm target/debug/libboxlite.a`).
3. **Re-cut the runner**: `build-runner-binary.yml` auto-triggers on the C-SDK
   `workflow_run` (or `workflow_dispatch`). It links the new libboxlite.a + in-repo
   `sdks/go` (`replace …/sdks/go => ../../sdks/go`, committed in `9ae01512`) →
   produces a **backup-capable** `boxlite-runner-v<ver>-linux-amd64`.
4. Provision the test runners with `--with-backup-sidecar --backups-bucket
   boxlite-volume-backups-dev` (Required-infra above) and re-run the migration E2E.

**Viability is confirmed** — building `apps/runner` from current source already
yields a backup-capable binary (the local E2E's `/tmp/boxlite-runner-backup`), and
the C SDK exports the needed symbols. Remaining work is purely the release action
(version bump + run the two CI workflows; needs repo release permissions).

Until that release lands, **scale-down auto-migration of live boxes is not
production-ready on AWS** (empty-runner scale-down + provision/terminate ARE
proven; box migration is proven on the local provider with a locally-built backup
runner). A one-off alternative for testing: cross-build a backup-capable
`boxlite-runner-linux-amd64` and SSM-deploy it to the runner EC2s.

## Test-environment note (rules honored)

The dev `default` runner was only ever **cordoned** (reversible scheduling flag)
during the placement/migration window and **restored to `unschedulable=false`**
afterward; its EC2/lifecycle was never touched. All test runners/boxes/EC2 were
created by the test and fully cleaned up.

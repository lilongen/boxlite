# Local Scale-Down E2E (provider=local) — 2026-05-27

End-to-end validation of Task 10 from
[`docs/superpowers/plans/2026-05-27-runner-ops-localprocess-provider.md`](../superpowers/plans/2026-05-27-runner-ops-localprocess-provider.md):
drive **add ×2 native runners → create box → scale-down (migrate box to peer) →
verify**, entirely through the runner-ops wrapper API with
`BOXLITE_RUNNER_OPS_PROVIDER=local`, on macOS Apple Silicon (M5).

## Result: PASS

All acceptance criteria met (clean run, scale-down job
`01KSMDFXEZAMJQP2SG8B54684G`):

| Criterion | Result |
| --- | --- |
| Box migrates to peer runner-B | ✅ `runnerId` = runner-B (`e509e174…`) |
| Box `started` after migration | ✅ `state=started`, `backupState=Completed` |
| `sandbox.id` preserved across migration | ✅ `85d4cdda-ba97-41b6-99c8-3f9b11ae82d7` (unchanged) |
| runner-A row deleted | ✅ `select count(*) from runner where id=A` → 0 |
| runner-A process gone | ✅ only runner-B (`:3101`, pid 59627) remains |
| runner-A home removed by `terminateRunner` | ✅ `~/.blr/<A-prefix>/` gone |

The 10-stage scale-down ran clean end to end:

```
[1/10] Preflight            peer pool (shared, ready, schedulable, region=us): 1 → e2e-runner-b
[2/10] Cordon source        runner cordoned
[3/10] Enumerate sandboxes  started=1 stopped=0 skipped=0
[4/10] Stop                 ✓ STOPPED
[5/10] Ensure backup        ✓ backup COMPLETED   (in-process export → MinIO s3://boxlite/<id>.boxlite)
[6/10] Archive (detach)     ✓ ARCHIVED and detached (runnerId=null)
[7/10] Restart on peer      ✓ STARTED on e2e-runner-b   (in-process import from backup archive)
[8/10] Drain wait           source has 0 non-archived/destroyed sandboxes
[9/10] DELETE runner row    ✓ runner row deleted
[10/10] Terminate host      → host terminated (process killed + home dir removed)
```

## Environment

- Control plane dogfooded inside BoxLite boxes (not docker): postgres `:25432`
  (boxlite/boxlite/boxlite), redis `:26379`, registry `:25000`, MinIO `:29000`
  (minioadmin, bucket `boxlite`). SHARED region `us`.
- API: `node apps/dist/apps/api/main.js` on `:3009`, single process, crons ON.
- Admin token / org API key: `local-dev-admin-key` (the seeded `boxlite-admin`
  key — see [Auth note](#auth-the-admin-token-is-also-an-org-api-key)).
- Snapshot: `ubuntu:22.04` (general, org `19b3887e` Personal).

## Build steps that unblocked the run

### 1. Backup-capable native runner (`/tmp/boxlite-runner-backup`)

The sibling's `/tmp/boxlite-runner` is vanilla (no in-process backup/restore).
Built a backup-capable runner from **this tree** via static linking against the
local debug libboxlite (which exports `_boxlite_box_export` +
`_boxlite_runtime_import_box`):

```bash
make dev:go                       # builds target/debug/libboxlite.a (symbols verified)
                                  # + builds sdks/go with -tags boxlite_dev
# apps/runner/go.mod: add `replace github.com/boxlite-ai/boxlite/sdks/go => ../../sdks/go`
( cd apps/runner && GOTOOLCHAIN=auto go build -tags boxlite_dev -o /tmp/boxlite-runner-backup ./cmd/runner )
```

`otool -L /tmp/boxlite-runner-backup` shows **no external dylib deps** —
libboxlite/libkrun/libkrunfw are statically linked / embedded. Therefore
**`DYLD_LIBRARY_PATH` is not needed** and `BOXLITE_RUNNER_OPS_LOCAL_DYLD` is left
unset. (The handoff's DYLD/dylib framing was for a dynamically-linked variant;
the `boxlite_dev` static build supersedes it.)

### 2. API bundle (`apps/dist/apps/api/main.js`)

Two blockers, both resolved at the source (no webpack `emitOnErrors` hack
needed):

- **`apps/apps -> .` symlink.** The nx workspace root is `apps/`, but
  `apps/api/project.json` uses repo-root-relative paths (`apps/api/...`), so the
  webpack config resolved to `apps/apps/api/webpack.config.js`. A relocation
  artifact; `ln -sfn . apps/apps` bridges it. (Not committed — symlink under a
  symlinked dir; git refuses to track it.)
- **Missing dependency `@aws-sdk/client-ec2`.** The `IInfraProvider` refactor
  extracted EC2 logic into `apps/infra/lib/infra-provider/aws.ts`, which
  top-level-imports `@aws-sdk/client-ec2`, but the dep was never declared.
  `factory.ts` imports `aws.js` eagerly, so the API would crash at boot even with
  provider=local. **Fix: added `@aws-sdk/client-ec2@^3.901.0` to
  `apps/package.json`** (alongside the existing `@aws-sdk/*` deps). After this the
  bundle compiles cleanly.

Build: `cd apps && NODE_ENV=development NX_DAEMON=false corepack yarn nx build api --skip-nx-cache`.

## Findings (two real bugs)

### A. `BOXLITE_RUNNER_OPS_LOCAL_API_URL` must NOT carry the `/api` suffix

The plan suggested `BOXLITE_RUNNER_OPS_API_URL=http://localhost:3009/api`, but
[`add-shared-runner-lib.ts`](../../apps/infra/lib/add-shared-runner-lib.ts)
appends `/api/admin/runners` itself → `GET /api/api/admin/runners` → 404.
**Correct value: `http://localhost:3009`** (no `/api`). The
`LocalProcessInfraProvider` re-adds `/api` for the runner's own
`BOXLITE_API_URL` via `runnerApiUrl()`, so the runner still gets the right URL.

### B. macOS `SUN_LEN`: `LOCAL_HOME_ROOT` must be short (use the `~/.blr` default)

The plan suggested `LOCAL_HOME_ROOT=~/.boxlite-runner-ops` (35 chars). That
**overflows the macOS unix-socket path limit (`SUN_LEN`, 104 bytes) on the
restore path**, but only on restore — not on a normal create:

- Normal create: `runtime.Create(...)` with `WithName(sandboxId)` → the runtime
  generates a **short** box id for the box dir, so the socket path fits.
- Restore: [`stubs.go`](../../apps/runner/pkg/boxlite/stubs.go)
  `runtime.ImportBox(archive, id=sandboxId, name=sandboxId)` forces
  **`box.id = sandbox.id`** (full 36-char UUID) to preserve `sandbox.id == box.id`.

Worst-case restore socket path:
```
/Users/lilongen/.boxlite-runner-ops/<12-char-runner>/boxes/<36-char-sandbox-id>/sockets/ready.sock
= 110 chars  →  exceeds SUN_LEN (103 usable)  →  "Failed to bind ready socket … path must be shorter than SUN_LEN"
```
With the **code default `~/.blr`** (20 chars) the same path is **95 chars** →
fits. **Fix: keep `BOXLITE_RUNNER_OPS_LOCAL_HOME_ROOT=~/.blr`** (do not override
with a longer root). The `LocalProcessInfraProvider`'s existing 12-char
runner-prefix trick is necessary but not sufficient on its own — the home-root
length is the remaining budget. A boundary guard in `local.ts` that rejects an
over-long home root (worst case = home + 12 + `/boxes/` + 36 + `/sockets/ready.sock`)
would have caught this immediately; recommended as a follow-up.

### C. Intermittent runner crash in Go SDK `ListInfo` (sandbox-sync)

The runner occasionally crashes with a Go runtime fatal error during the
periodic sandbox-sync (hardcoded 10s, `main.go:136`):

```
fatal error: invalid pointer found on stack
runtime.cgoCheckPointer(...)
github.com/boxlite-ai/boxlite/sdks/go.(*Runtime).ListInfo.func1   sdks/go/info.go:65
github.com/boxlite-ai/runner/pkg/services.(*SandboxSyncService).GetLocalContainerStates  sandbox_sync.go:41
```

`runtime.adjustpointers: invalid pointer found on stack` during `copystack`
while `cgoCheckPointer` is on the stack points to memory corruption at the
SDK's CGO boundary in `boxlite_list_info`, surfaced when the syncing goroutine's
stack grows. It is **intermittent and memoryless per sync cycle** — some runs
survive several minutes (this PASS run did); others die within the first minute
(an earlier run died mid snapshot-pull, abandoning the pull). This is an
**SDK-layer defect, not a scale-down/provider defect**, but it can flake the
local E2E. Tracked as a follow-up; out of scope for Task 10. Reproduced on the
`boxlite_dev` (debug) build — worth checking whether a release libboxlite is
stable.

## Reproduce

`apps/api/.env` runner-ops block (gitignored):
```
BOXLITE_RUNNER_OPS_PROVIDER=local
BOXLITE_RUNNER_OPS_API_URL=http://localhost:3009        # NO /api suffix (Finding A)
BOXLITE_RUNNER_OPS_ADMIN_TOKEN=local-dev-admin-key
BOXLITE_RUNNER_OPS_LOCAL_RUNNER_BIN=/tmp/boxlite-runner-backup
BOXLITE_RUNNER_OPS_LOCAL_HOME_ROOT=~/.blr               # short root (Finding B)
BOXLITE_RUNNER_OPS_LOCAL_PORT_BASE=3100
BOXLITE_RUNNER_OPS_LOCAL_INSECURE_REGISTRIES=127.0.0.1:25000
BOXLITE_RUNNER_OPS_BACKUP_BUCKET=boxlite
BOXLITE_RUNNER_OPS_BACKUP_ENDPOINT=http://127.0.0.1:29000
BOXLITE_RUNNER_OPS_BACKUP_REGION=us-east-1
BOXLITE_RUNNER_OPS_BACKUP_ACCESS_KEY=minioadmin
BOXLITE_RUNNER_OPS_BACKUP_SECRET_KEY=minioadmin
# DYLD intentionally unset — static runner binary
```

Driver script: `/tmp/e2e-scaledown.sh` (add ×2 → cordon peers + local-m5 →
create box on A → uncordon B → scale-down A → verify). Auth uses
`Authorization: Bearer local-dev-admin-key`.

### Auth: the admin token is also an org API key

`app.service.ts:192` seeds the `boxlite-admin` API key with
`value = admin.apiKey` (`ADMIN_API_KEY`). So `local-dev-admin-key` works both as
the runner-ops ADMIN bearer token **and** as the org API key (org `19b3887e`)
for `POST /api/sandbox`. No separate key needed for local E2E.

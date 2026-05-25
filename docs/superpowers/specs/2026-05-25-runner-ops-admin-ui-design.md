# Design: Runner Ops Admin UI

**Status:** Draft (2026-05-25)
**Scope:** Admin-only dashboard page exposing manual `add shared runner` and `scale-down runner` operations by reusing the already-validated `apps/infra/scripts/*` orchestration logic as in-process libraries.
**Branch:** `feat/cloud-mvp-runner-auto-scaling`
**Predecessors:**
- `docs/superpowers/specs/2026-05-21-add-runner-script-design.md` (CUSTOM runner script)
- `docs/runner-scaling/scale-down-design.md` (10-stage scale-down design)
- `docs/runner-scaling/README.md` (index of scripts + e2e reports v1–v5)

---

## 1. Goal

Give a platform operator a web UI that:

1. Lists all SHARED-region runners with their health and load (TOPSIS score, sandbox count, region, state).
2. Provisions a new SHARED runner by clicking **Add runner**, which invokes the same logic as `apps/infra/scripts/add-shared-runner.ts`.
3. Triggers a safe scale-down on a selected runner via a **Scale down** action, which invokes the same logic as `apps/infra/scripts/scale-down-runner.ts`.
4. Streams (via polling for MVP) the multi-stage progress of each long-running operation back into the UI.

The mechanism for invoking scripts is **lib extraction** (`Option β`): the scripts become reusable TypeScript modules consumed both by the existing CLIs and by a new NestJS service. No shell-out, no separate worker process.

The platform retains its existing CLI escape hatches (`tsx scripts/add-shared-runner.ts`, `tsx scripts/scale-down-runner.ts`) — these continue to work post-refactor and are operator fallbacks if the UI is unavailable.

## 2. Non-Goals

This release explicitly does **not** introduce:

- **Auto-scaling decision logic.** No cron-driven scale-up/scale-down, no `IInfraProvider` abstraction, no `AutoscalerService`. The operator presses every button manually.
- **CUSTOM runner provisioning UI.** `add-runner.ts` (per-org CUSTOM region) keeps its existing CLI-only operator surface. The UI handles only SHARED runners.
- **Real-time SSE log streaming.** The UI polls a job-status endpoint every 2 s. SSE can be added later without changing the back-end contract; the lib already produces a stream of progress events.
- **Multi-runner concurrent operations.** A single Redis lock per operation kind (`add` and `scale-down`) prevents two concurrent jobs of the same kind; the second caller receives HTTP 409.
- **Job history beyond 24 hours.** Job records live in Redis with TTL 24h. Long-term audit goes through the existing `AuditModule`.
- **API restart resilience for in-flight jobs.** If `apps/api` restarts while a job is running, the lib call is interrupted; the job record is marked `STALE` after a watchdog timeout (5 min). The operator must inspect EC2 + DB state and re-run manually.

## 3. Current State (researched 2026-05-25)

### 3.1 API side — admin infrastructure complete

| Capability | Location | Status |
| --- | --- | --- |
| `SystemRole.ADMIN`/`USER` enum | `apps/api/src/user/enums/system-role.enum.ts:7` | Ready |
| `@RequiredSystemRole(SystemRole.ADMIN)` decorator | `apps/api/src/common/decorators/required-role.decorator.ts` | Ready |
| `SystemActionGuard` enforces role | `apps/api/src/auth/system-action.guard.ts:14` | Ready |
| `AdminRunnerController` at `/admin/runners` | `apps/api/src/admin/controllers/runner.controller.ts:37` | Ready |
| `AuthContext.role` accessible server-side | `apps/api/src/common/interfaces/auth-context.interface.ts` | Ready |
| **`UserDto` exposes `role` to client** | `apps/api/src/user/dto/user.dto.ts:39` | **MISSING — `fromUser()` does not map `user.role`** |
| `RedisLockProvider` for cross-cron mutex | `apps/api/src/sandbox/common/redis-lock.provider.ts` | Ready, 5+ existing call sites |
| `@nestjs-modules/ioredis` Redis client | `apps/api/src/app.module.ts:124` | Ready |

### 3.2 Dashboard side — no platform-admin gating

- `apps/dashboard/src/` contains **zero** references to `isAdmin`, `SystemRole`, `adminRole`, `platformRole`, or any similar gating concept. Grep result is empty.
- `RoutePath` enum (`apps/dashboard/src/enums/RoutePath.ts`) contains no `/admin/*` paths.
- The existing `Runners` page (`apps/dashboard/src/pages/Runners.tsx`) is **per-organization**: it uses `useSelectedOrganization()` and calls `runnersApi.createRunner(data, selectedOrganization.id)` — the org-scoped endpoint, not the admin endpoint.
- `useApi()` exposes the auto-generated `@boxlite-ai/api-client`; that client cannot today distinguish admin from user because the API doesn't return `role` on `GET /users/me`.

### 3.3 Scripts side — already validated and structurally importable

| Script | Lines | `main()` line | Notes |
| --- | --- | --- | --- |
| `apps/infra/scripts/add-shared-runner.ts` | 681 | `505` | Already exports `EXIT`, `RUNNER_NAME_REGEX`, `validateRunnerName`. Uses `invokedDirectly` guard so it is safe to import as a module. |
| `apps/infra/scripts/scale-down-runner.ts` | 832 | `490` | 10-stage flow, validated end-to-end 5 times (v1–v5 reports). Progress goes to `stderr` line-by-line plus a JSON result file via `ResultWriter`. |

Both scripts:

- Take inputs from `commander` argv.
- Write progress to `stderr` (already line-prefixed like `[3/10] enumerate sandboxes…`).
- Persist a JSON result file (`add-result.json`, `scale-down-result.json`).
- Use `@aws-sdk/client-ec2` directly — `RunInstances`, `DescribeImages`, `DescribeInstances`, `TerminateInstancesCommand`.
- Require `BOXLITE_ADMIN_API_KEY`, `BOXLITE_API_URL`, `AWS_REGION` envs.

This shape is straightforward to convert into `async function*` generators that yield typed progress events.

### 3.4 Sibling worktrees (informational, no coupling decisions in this spec)

- `feat/cloud-mvp` — infra-local foundation, has its own `LimaInfraProvider` work (not consumed here; we use AWS only in this UI).
- `feat/cloud-mvp-feature-pruning` — pruning of unused Daytona features; may touch the same `apps/dashboard` pages list. We will resolve any conflict at merge time; this spec does not block on it.

## 4. Mental Model

```
┌────────────────────────────────────────────────────────────────────────┐
│ apps/dashboard/src/pages/admin/RunnerOps.tsx  (new, admin-only)        │
│                                                                        │
│   • Table:    list of SHARED runners (live, with auto-refresh)         │
│   • Action:   [+ Add runner] button → AddSharedRunnerDialog            │
│   • Action:   per-row [Scale down] → ScaleDownDialog                   │
│   • Status:   per-job progress modal (polls /admin/runner-ops/jobs/:id)│
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                              │ admin-auth REST (Bearer)
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ apps/api/src/admin/                                                    │
│                                                                        │
│   RunnerOpsController       /admin/runner-ops/*  (SystemActionGuard)   │
│   RunnerOpsService          orchestrates lib calls + job lifecycle     │
│   RunnerOpsJobStore         Redis-backed job state (TTL 24h)           │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                              │ in-process function call
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ apps/infra/lib/  (new, shared between CLIs and apps/api)               │
│                                                                        │
│   add-shared-runner-lib.ts                                             │
│     export async function* addSharedRunner(opts):                      │
│         AsyncGenerator<ProgressEvent, AddResult, void>                 │
│                                                                        │
│   scale-down-runner-lib.ts                                             │
│     export async function* scaleDownRunner(opts):                      │
│         AsyncGenerator<ProgressEvent, ScaleResult, void>               │
│                                                                        │
│   runner-ops-types.ts (shared event/options/result types)              │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────┐        ┌────────────────────────────────┐
│ AWS EC2                      │        │ apps/api existing REST         │
│ RunInstances / DescribeImages│        │ POST /admin/runners            │
│ DescribeInstances / Terminate│        │ PATCH /admin/runners/:id/      │
└──────────────────────────────┘        │   scheduling                   │
                                        │ POST /sandbox/:id/{stop,       │
                                        │   backup,archive,start}        │
                                        │ DELETE /admin/runners/:id      │
                                        └────────────────────────────────┘
```

The CLI entry points (`apps/infra/scripts/*.ts`) shrink to thin shells: parse argv → call the lib → print yielded events to `stderr` → exit with the returned status code. Their externally observable behaviour stays identical so existing operator runbooks continue to work.

## 5. Prerequisite Changes (P-series)

Three small changes must land before the main work to unblock admin-gating in the dashboard. They are independently useful and reviewable.

### P1. `UserDto` exposes `role`

`UserDto.fromUser()` in `apps/api/src/user/dto/user.dto.ts:39` does not include `user.role`. Without it the dashboard cannot tell whether the current user is a platform admin.

Add:

```typescript
@ApiProperty({
  description: 'System role',
  enum: SystemRole,
})
role: SystemRole

// in fromUser():
role: user.role,
```

### P2. Regenerate `@boxlite-ai/api-client`

Run the existing generator (whatever target produces `libs/api-client-ts/`). The new `role` field surfaces on `User`. No manual editing.

### P3a. Dashboard `useCurrentUser` hook (or extend `ApiContext`)

The dashboard does not currently load `/users/me` into a context. Add a hook that calls `usersApi.getAuthenticatedUser()` once on mount and caches the result. Expose:

```typescript
export function useCurrentUser(): {
  user: User | null
  loading: boolean
  isPlatformAdmin: boolean
}
```

Implementation owns one fetch + an `useEffect` retry on 401. If the project already wraps `/users/me` somewhere we haven't found (search wasn't exhaustive), this hook simply layers `isPlatformAdmin` on top of the existing source.

### P3b. `<RequireAdmin>` route guard

```typescript
// apps/dashboard/src/components/auth/RequireAdmin.tsx
export const RequireAdmin: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user, loading, isPlatformAdmin } = useCurrentUser()
  if (loading) return <Spinner />
  if (!user || !isPlatformAdmin) return <Navigate to={RoutePath.SANDBOXES} replace />
  return <>{children}</>
}
```

Add `RoutePath.ADMIN_RUNNER_OPS = '/dashboard/admin/runner-ops'`. Wrap the new page route with `<RequireAdmin>` in `App.tsx`.

## 6. Change List

Ordered by execution dependency. Prerequisite items P1–P3b go first.

| # | Layer | File / module | Action | LOC (net) |
| --- | --- | --- | --- | --- |
| P1 | api | `apps/api/src/user/dto/user.dto.ts` | Add `role` to DTO and `fromUser()`. | ~10 |
| P2 | api-client | `libs/api-client-ts/**` | Regenerate from OpenAPI. | auto |
| P3a | dashboard | `apps/dashboard/src/hooks/useCurrentUser.ts` (new) | Load `/users/me`, expose `isPlatformAdmin`. | ~60 |
| P3b | dashboard | `apps/dashboard/src/components/auth/RequireAdmin.tsx` (new) | Route guard. | ~25 |
| P3b | dashboard | `apps/dashboard/src/enums/RoutePath.ts` | Add `ADMIN_RUNNER_OPS`. | ~2 |
| 1 | infra-lib | `apps/infra/lib/runner-ops-types.ts` (new) | Shared `ProgressEvent`/`AddOpts`/`ScaleOpts`/`*Result` types. | ~90 |
| 2 | infra-lib | `apps/infra/lib/add-shared-runner-lib.ts` (new) | Move logic out of script's `main()`; expose `async function* addSharedRunner(opts)` yielding `ProgressEvent`s and returning `AddResult`. | ~620 (move + reshape) |
| 3 | infra-lib | `apps/infra/lib/scale-down-runner-lib.ts` (new) | Same treatment for `scaleDownRunner(opts)`. | ~720 (move + reshape) |
| 4 | infra-scripts | `apps/infra/scripts/add-shared-runner.ts` | Reduce to argv → lib → stderr/exit shell. | ~90 retained |
| 5 | infra-scripts | `apps/infra/scripts/scale-down-runner.ts` | Same shell shape. | ~90 retained |
| 6 | api | `apps/api/src/admin/services/runner-ops-job-store.ts` (new) | Redis CRUD wrapper: `create(jobId)`, `appendLine(jobId, line)`, `complete(jobId, result)`, `fail(jobId, msg)`, `get(jobId)`. TTL 24h. | ~140 |
| 7 | api | `apps/api/src/admin/services/runner-ops.service.ts` (new) | Wraps lib calls; consumes the `AsyncGenerator`; persists progress to job store; enforces per-kind Redis lock to block concurrent jobs of the same kind. | ~280 |
| 8 | api | `apps/api/src/admin/dto/runner-ops.dto.ts` (new) | Request and response DTOs: `AddSharedRunnerRequestDto`, `ScaleDownRequestDto`, `JobDto`, `ListSharedRunnersResponseDto`. | ~110 |
| 9 | api | `apps/api/src/admin/controllers/runner-ops.controller.ts` (new) | Five endpoints (see §7). Protected by `SystemActionGuard` + `@RequiredSystemRole(SystemRole.ADMIN)`. | ~180 |
| 10 | api | `apps/api/src/admin/admin.module.ts` | Register controller + services. | ~15 |
| 11 | api-client | `libs/api-client-ts/**` | Regenerate (covers new endpoints). | auto |
| 12 | dashboard | `apps/dashboard/src/pages/admin/RunnerOps.tsx` (new) | Page layout, header, table, dialogs. | ~310 |
| 13 | dashboard | `apps/dashboard/src/components/admin/RunnerOpsTable.tsx` (new) | Table with rows, state badges, score, sandboxes, region, scale-down action. | ~160 |
| 14 | dashboard | `apps/dashboard/src/components/admin/AddSharedRunnerDialog.tsx` (new) | Form (name, region, instance type), submit → POST → poll job. | ~180 |
| 15 | dashboard | `apps/dashboard/src/components/admin/ScaleDownDialog.tsx` (new) | Confirmation + live job log (stage list + line tail). | ~180 |
| 16 | dashboard | `apps/dashboard/src/hooks/useRunnerOpsJob.ts` (new) | Polls `/admin/runner-ops/jobs/:id` every 2 s; cancels on unmount; exposes `{ status, lines, result, error }`. | ~80 |
| 17 | dashboard | `apps/dashboard/src/App.tsx` | Add admin section: `<Route path={RoutePath.ADMIN_RUNNER_OPS} element={<RequireAdmin><RunnerOps/></RequireAdmin>}/>`. | ~10 |
| 18 | dashboard | sidebar/navigation component (locate via `grep "RoutePath.SANDBOXES"`) | Conditional "Runner Ops" entry visible only when `isPlatformAdmin`. | ~15 |
| 19 | tests | `apps/api/src/admin/services/__tests__/runner-ops.service.spec.ts` (new) | Unit tests: lock enforcement, lib mocking, job lifecycle, failure capture. | ~180 |
| 20 | tests | `apps/api/src/admin/services/__tests__/runner-ops-job-store.spec.ts` (new) | Redis-backed store: TTL, append, complete, fail. | ~120 |
| 21 | tests | `apps/infra/lib/__tests__/*.test.ts` (new) | Per-lib unit tests: mock AWS SDK + apps/api fetch; assert event ordering + result shape. | ~250 |
| 22 | docs | `docs/runner-scaling/runner-ops-ui-runbook.md` (new, English) | Operator runbook: how to launch via UI, how to fall back to CLI, troubleshooting. | ~200 |

**Net new LOC ≈ 1,650** (excluding moves from scripts).

## 7. API Contract

### 7.1 Endpoints (all under `@RequiredSystemRole(SystemRole.ADMIN)`)

```
GET    /admin/runner-ops/shared
       → ListSharedRunnersResponseDto
       → 200 OK

POST   /admin/runner-ops/add-shared
       body: AddSharedRunnerRequestDto
       → JobDto (status=PENDING)
       → 202 Accepted on success
       → 409 Conflict if another add-shared job is RUNNING

POST   /admin/runner-ops/:runnerId/scale-down
       body: ScaleDownRequestDto
       → JobDto (status=PENDING)
       → 202 Accepted on success
       → 409 Conflict if another scale-down is RUNNING anywhere
       → 404 if runner not found
       → 400 if runner is not SHARED or not READY

GET    /admin/runner-ops/jobs/:jobId
       → JobDto
       → 200 OK
       → 404 if not in Redis (expired or never existed)

POST   /admin/runner-ops/jobs/:jobId/cancel  (best-effort)
       → JobDto with status=CANCEL_REQUESTED
       → 200 OK
       Note: cancellation is cooperative; the lib generator checks an
       AbortSignal at each yield point. Stages already in flight on
       AWS/EC2 cannot be reverted by cancellation; cleanup is operator-led.
```

### 7.2 DTOs

```typescript
// AddSharedRunnerRequestDto
{
  name?: string                  // optional; defaulted by lib if absent
  regionId?: string              // optional; default 'us'
  instanceType?: string          // optional; default 'c8i.2xlarge'
  diskGb?: number                // optional; default 100
  withBackupSidecar?: boolean    // dev-only opt-in
  yes?: boolean                  // skip TTY confirm (UI always true)
}

// ScaleDownRequestDto
{
  yes?: boolean                  // UI always true
  restartStopped?: boolean       // default false
  skipEc2Terminate?: boolean     // default false; debug only
  dryRun?: boolean               // default false
  maxWaitBackupSec?: number      // default 900
  maxWaitStopSec?: number        // default 120
  maxWaitArchiveSec?: number     // default 120
  maxWaitStartSec?: number       // default 600
}

// JobDto
{
  id: string                     // ULID
  kind: 'add-shared' | 'scale-down'
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCEL_REQUESTED' | 'STALE'
  startedAt: string              // ISO 8601
  finishedAt?: string
  currentStage?: number          // 1-based; matches lib events
  totalStages?: number
  lines: string[]                // human-readable progress (capped at 1,000)
  exitCode?: number              // 0 on success
  result?: AddResult | ScaleResult
  error?: { message: string; stage?: number }
}

// ListSharedRunnersResponseDto
{
  runners: Array<{
    id: string
    name: string
    regionId: string
    regionType: 'shared'         // always shared in this endpoint
    state: RunnerState
    availabilityScore: number    // 0–100
    cpu: number                  // provisioned
    memoryGiB: number
    diskGiB: number
    currentStartedSandboxes: number
    currentCpuUsagePercentage: number
    currentMemoryUsagePercentage: number
    currentDiskUsagePercentage: number
    unschedulable: boolean
    draining: boolean
    lastChecked: string          // ISO
    activeJob?: {
      jobId: string
      kind: 'scale-down'         // an add-shared job is not tied to a runner
      status: JobDto['status']
    }
  }>
}
```

`ListSharedRunnersResponseDto.runners` is built by `RunnerService.findAllFull()` filtered by `regionType === 'shared'` (see §10.3 for the filtering implementation note).

## 8. Lib API

### 8.1 Shared types (`apps/infra/lib/runner-ops-types.ts`)

```typescript
export type ProgressEvent =
  | { type: 'stage';        stage: number; total: number; label: string }
  | { type: 'log';          line: string }
  | { type: 'data';         key: string; value: unknown }   // structured side-channel
  | { type: 'warning';      line: string }

export interface AddSharedRunnerOpts {
  apiUrl: string
  adminToken: string
  awsRegion: string
  name?: string
  regionId?: string
  instanceType?: string
  diskGb?: number
  withBackupSidecar?: boolean
  registryUrl?: string
  subnetId?: string
  instanceProfileName?: string
  signal?: AbortSignal
}

export interface AddSharedRunnerResult {
  runnerId: string
  runnerName: string
  apiKey: string                 // redacted by callers — never logged at log level
  ec2InstanceId: string
  privateIp?: string
  finalState: 'READY' | 'INITIALIZING' | 'TIMEOUT'
}

export interface ScaleDownOpts {
  apiUrl: string
  adminToken: string
  awsRegion: string
  runnerId: string
  restartStopped?: boolean
  skipEc2Terminate?: boolean
  dryRun?: boolean
  maxWaitBackupSec?: number
  maxWaitStopSec?: number
  maxWaitArchiveSec?: number
  maxWaitStartSec?: number
  signal?: AbortSignal
}

export interface ScaleDownResult {
  runnerId: string
  sandboxesMigrated: string[]    // sandbox IDs that crossed runners
  sandboxesArchived: string[]    // were not restarted (e.g. originally STOPPED + restartStopped=false)
  ec2InstancesTerminated: string[]
  durationMs: number
}
```

### 8.2 Generator contract

```typescript
export async function* addSharedRunner(
  opts: AddSharedRunnerOpts,
): AsyncGenerator<ProgressEvent, AddSharedRunnerResult, void>

export async function* scaleDownRunner(
  opts: ScaleDownOpts,
): AsyncGenerator<ProgressEvent, ScaleDownResult, void>
```

Conventions:

- The first event of every successful call is `{ type: 'stage', stage: 1, total: <N>, label: ... }`.
- `data` events surface secrets (e.g. `apiKey`) so the service layer can store them out-of-band rather than appending them to log lines.
- `signal.aborted` is checked at every `await` boundary; on abort the generator throws `OperationAbortedError`.
- On AWS or REST failure the generator throws; the existing `EXIT.*` constants on the scripts are no longer needed because errors propagate as exceptions.

### 8.3 CLI shell shape

```typescript
// apps/infra/scripts/add-shared-runner.ts (post-refactor)
import { addSharedRunner } from '../lib/add-shared-runner-lib'
import { parseArgs } from './_argparse-add-shared-runner'

async function main() {
  const opts = parseArgs(process.argv)
  try {
    for await (const ev of addSharedRunner(opts)) {
      if (ev.type === 'stage') process.stderr.write(`[${ev.stage}/${ev.total}] ${ev.label}\n`)
      else if (ev.type === 'log') process.stderr.write(`${ev.line}\n`)
      else if (ev.type === 'warning') process.stderr.write(`WARN: ${ev.line}\n`)
      // 'data' events go silently to result file (existing behaviour)
    }
    return 0
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`)
    return mapExitCode(e)
  }
}
```

`parseArgs` and the `commander` boilerplate remain in the script file (they belong to the CLI layer, not the lib).

## 9. Job Model (Redis-backed)

### 9.1 Schema

```
Key:    runner-ops:job:{jobId}
TTL:    86400 s (24h)
Value:  JSON document matching JobDto
        (lines truncated to last 1,000 entries to bound memory)

Key:    runner-ops:lock:add-shared
TTL:    1800 s (30 min, sufficient for any add scenario)
Value:  the active jobId
        Acquired before starting an add-shared job; released on completion.

Key:    runner-ops:lock:scale-down
TTL:    3600 s (60 min, scale-down can be slow with many sandboxes)
Value:  the active jobId
```

### 9.2 Lifecycle

1. Controller validates request and reserves a fresh ULID jobId.
2. Service attempts `SET NX EX` on `runner-ops:lock:{kind}`; on failure returns 409.
3. Service writes job record with status `PENDING`, returns to controller.
4. Service starts an async task (no `await` from controller) that:
   - Updates status to `RUNNING`.
   - Iterates the lib generator, persisting each `stage`/`log`/`warning` event into `lines` and `currentStage`.
   - On `data` events, stores `data.value` under `result.<data.key>` (used for `apiKey` so it never leaks into `lines`).
   - On generator completion, sets `status=SUCCESS`, `finishedAt`, `exitCode=0`, `result=<final return value>`, releases the lock.
   - On generator throw, sets `status=FAILED`, `error={message, stage?}`, releases the lock.
5. A watchdog (controller-level, no separate cron) sets a logical "stale" flag when `now - startedAt > 30 min` on read of jobs still marked `RUNNING`; this surfaces stuck jobs to operators after API restarts.

### 9.3 Lock granularity rationale

One lock per kind, not per runner. Rationale:

- `add-shared` racing with itself produces two EC2 instances and two runner rows; both will sit in `INITIALIZING` until healthcheck; no data loss but operator confusion is high.
- `scale-down` racing with itself can pick the same runner twice (unlikely if UI prevents it) or two different runners simultaneously (worse: peer-pool selection in `getRandomAvailableRunner` becomes non-deterministic). Serializing is safer for MVP.

If operators later need parallel scale-downs across regions, we can shard the lock by `regionId`.

## 10. Data Flow

### 10.1 Add shared runner (happy path)

```
UI            Controller     Service             Lib                AWS / API
 │ click Add    │             │                   │                   │
 ├─POST add────►│             │                   │                   │
 │              ├─validate    │                   │                   │
 │              ├─SETNX lock──►Redis              │                   │
 │              ├─create job──►Redis              │                   │
 │◄────202 jobId│             │                   │                   │
 │              │             ◄──spawn task──     │                   │
 │              │             │ for await event   │                   │
 │              │             │   in lib(opts)    │                   │
 │              │             │                   ├─generate apiKey   │
 │              │             │                   ├─POST /admin/      │
 │              │             │                   │    runners────────►apps/api
 │              │             │                   ◄────────runnerId───┤
 │              │             │   yield stage 1   │                   │
 │              │             │   yield data:key  │                   │
 │              │             │                   ├─resolve AMI──────►EC2
 │              │             │                   ├─RunInstances─────►EC2
 │              │             │                   ◄────instanceId────┤
 │              │             │   yield stage 5   │                   │
 │              │             │                   ├─poll runner state ►apps/api
 │              │             │   yield stage 7   │                   │
 │              │             │                   ◄────state=READY────┤
 │              │             │   return AddResult│                   │
 │              │             ├─persist result    │                   │
 │              │             ├─DEL lock ────────►Redis              │
 │ poll GET job ►              │                   │                   │
 │◄──jobDto────                │                   │                   │
 │ ... (every 2s while RUNNING)│                   │                   │
 │ poll       ──►              │                   │                   │
 │◄──SUCCESS + result          │                   │                   │
 │ display result + close dialog                  │                   │
```

### 10.2 Scale down (happy path summarized; full 10 stages in scale-down-design.md §3)

```
UI            Controller     Service             Lib                apps/api / EC2
 │ confirm      │             │                   │                   │
 ├─POST :id/sd─►│             │                   │                   │
 │              ├─load runner ─►apps/api          │                   │
 │              ├─assert SHARED+READY             │                   │
 │              ├─SETNX scale-down lock           │                   │
 │              ├─create job                       │                   │
 │◄─202 jobId   │             │                   │                   │
 │              │             ←spawn task         │                   │
 │              │             │ lib generator ────►stage 1 preflight  │
 │              │             │                   ├─PATCH cordon──────►apps/api
 │              │             │                   ├─GET /sandbox/for-runner
 │              │             │                   ├─POST stop x N
 │              │             │                   ├─POST backup x N
 │              │             │                   ├─POST archive x N
 │              │             │                   ├─POST start x N (peer)
 │              │             │                   ├─poll drain
 │              │             │                   ├─DELETE /admin/runners/:id
 │              │             │                   ├─DescribeInstances
 │              │             │                   ├─TerminateInstances
 │              │             │   return result   │                   │
 │              │             ├─finalize job      │                   │
 │ poll ──► SUCCESS                                │                   │
```

## 11. Error Handling and Rollback

The 10-stage scale-down already commits side effects step-by-step; partial failure is not new. The UI surfaces failures from the lib generator and shows the operator which stage stopped:

| Failure stage | UI message | Operator recovery |
| --- | --- | --- |
| Preflight | "Runner is not SHARED+READY" | None; pick another runner or wait for it to become READY. |
| Cordon | "Failed to PATCH scheduling" | Retry; nothing committed. |
| Backup | "Backup of sandbox X timed out at Ys" | `runner-ops:lock:scale-down` is released; runner stays cordoned. Operator uncordons (`PATCH scheduling unschedulable=false`) and inspects sandbox X. |
| Migrate (start on peer) | "No peer runner accepted sandbox X" | Sandbox is in ARCHIVED runnerId=null; operator restarts manually with a target runner. Runner DELETE is blocked until clean. |
| DELETE runner row | HTTP 428 — error-state sandboxes block delete | Surface the error; operator force-destroys those sandboxes via existing CLI (`scale-down-runner.ts --skip-ec2-terminate` is the existing manual fallback). |
| Terminate EC2 | "EC2 termination failed (rate limit?)" | Runner row is gone; orphan EC2 must be terminated manually via AWS console or `aws ec2 terminate-instances`. |

The lib does not attempt automatic rollback. Operators have manual fallbacks (existing CLI scripts) for every recovery path.

`AbortSignal` cooperative cancellation is best-effort: any AWS/REST call already in flight at the abort point completes; the generator throws `OperationAbortedError` at the next yield. The job ends in `FAILED` with an "aborted" error message.

## 12. Configuration and AWS IAM

### 12.1 New env vars on `apps/api`

| Var | Purpose | Default |
| --- | --- | --- |
| `BOXLITE_RUNNER_OPS_ADMIN_TOKEN` | The admin token the lib uses to self-call `apps/api` (during add). May reuse the SST-stored `AdminApiKey`. | Required |
| `BOXLITE_RUNNER_OPS_AWS_REGION` | AWS region for EC2 calls. | `ap-southeast-1` |
| `BOXLITE_RUNNER_OPS_SUBNET_ID` | Subnet to launch new runners into. | Required in prod |
| `BOXLITE_RUNNER_OPS_INSTANCE_PROFILE` | EC2 instance profile granting runner permissions. | Required in prod |
| `BOXLITE_RUNNER_OPS_REGISTRY_URL` | Snapshot registry URL passed to runner user-data. | Required in prod |

These mirror the env vars used by the existing CLI scripts. The lib accepts them as `opts.*`; the service reads `configService.get(...)` and forwards.

### 12.2 IAM additions on the API role

The `apps/api` deployment role (or its EC2 instance profile) needs:

```jsonc
{
  "Effect": "Allow",
  "Action": [
    "ec2:RunInstances",
    "ec2:DescribeInstances",
    "ec2:DescribeImages",
    "ec2:TerminateInstances",
    "ec2:CreateTags",
    "iam:PassRole"           // for InstanceProfile
  ],
  "Resource": "*"
}
```

`iam:PassRole` must be scoped to the runner instance profile ARN, not `*`. The exact ARN comes from `BOXLITE_RUNNER_OPS_INSTANCE_PROFILE`.

In the local dogfood environment (`apps/infra-local`), the API process inherits the developer's `AWS_PROFILE` and these policies are not relevant.

### 12.3 `apps/infra/sst.config.ts` update

Add the IAM policy block above to the API service definition. This is a small, reviewable IaC change; not in this branch's scope to land but listed so the operator who deploys this knows.

## 13. SHARED-runner filtering implementation

`RunnerService.findAllFull()` returns `RunnerFullDto[]` without a `regionType` filter. Options:

1. Add an optional argument `findAllFull({ regionType? }: { regionType?: RegionType })` and filter in the query. Lowest-risk change.
2. Filter in the new controller after fetching all. Acceptable for MVP (number of runners is small) but moves filtering up the stack.

**Decision: Option 1** for cleanliness and to avoid an N+1 join cost if regions become many. The change is one query builder argument plus one `.where()` clause.

## 14. Testing Strategy

### 14.1 Lib unit tests

- `addSharedRunner` and `scaleDownRunner` are tested with `@aws-sdk/client-ec2` mocked (`aws-sdk-client-mock`) and `fetch` mocked.
- Assertions cover: progress event ordering, secret redaction (apiKey appears only in `data` events, never in `log` events), error propagation, abort handling.

### 14.2 Service unit tests

- `RunnerOpsService` tested with a `MockJobStore` (in-memory) and a hand-rolled mock generator.
- Coverage: lock acquisition + release, job lifecycle states, concurrent-job rejection (409), abort signal propagation, exception capture.

### 14.3 Controller integration test

- Uses `@nestjs/testing` with `SystemActionGuard` enabled; assert 401 without admin token, 403 with non-admin, 202 with admin.
- Hits a real Redis (TestContainers) to validate TTL behaviour.

### 14.4 Dashboard component tests

- Vitest/React Testing Library on the three dialogs; mock the polling hook to step through `PENDING → RUNNING → SUCCESS`.
- Snapshot the table with a 3-runner fixture.

### 14.5 End-to-end (manual, dogfood)

In `apps/infra-local` Foundation environment:

1. Start the full stack.
2. Log in as the admin user.
3. Add a shared runner via UI; verify a new Lima/EC2 instance is provisioned and reaches READY.
4. Create a few sandboxes on the new runner.
5. Trigger scale-down via UI; verify all sandboxes migrate and the runner row is deleted.

This matches the existing e2e-multi-sandbox-report-v5 scenario but is driven through the UI.

## 15. Effort Estimate

| Day | Focus | Output |
| --- | --- | --- |
| 0 | Prerequisites P1, P2, P3a, P3b | UserDto exposes role; dashboard knows isPlatformAdmin; `RequireAdmin` works. |
| 1 | Lib extraction (changes 1, 2, 3, 4, 5) | Two new libs, two thin CLIs; CLI behaviour is byte-for-byte identical on stderr. |
| 2 | API service + controller + job store (changes 6–11) | Endpoints work via curl; SystemActionGuard enforced. |
| 3 | Dashboard page + dialogs + table + hook + routing (changes 12–18) | UI usable end-to-end in dev. |
| 4 | Tests (changes 19–21) + manual e2e | Suite green; one full dogfood e2e walked through. |
| 5 (half) | English design doc finalization, runbook, PR | This file converted into Implemented + the runbook. |

**Estimate: ~5.5 solo working days, with +0.5–1.0 day risk buffer for unknowns (`useCurrentUser` integration shape, AWS IAM debugging on staging).**

## 16. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Dashboard already has a `useCurrentUser` somewhere we didn't find and we duplicate it | Medium | Low (only wasted code, no behaviour bug) | Search `apps/dashboard/src/**` for `getAuthenticatedUser` and `/users/me` before writing the new hook. |
| AWS IAM permissions on the API service are insufficient | High in prod, low in dev | High (UI fails with cryptic AWS errors) | Document IAM additions in §12.2; assume infra/SST changes land separately before prod rollout. |
| Lib refactor changes CLI's exact stderr formatting and breaks operator runbooks | Medium | Medium | Add a snapshot test in `apps/infra/scripts/__tests__/` that asserts the CLI prints identical lines to the pre-refactor baseline. |
| In-flight job loss on API restart | Medium | Medium | Document in §2 and §9.2; surface STALE status. Production rollout should coincide with low-traffic windows. |
| 409 conflict during fast UI clicks confuses operators | Low | Low | UI disables the buttons while a job of that kind is in-flight, falling back to 409 only on race. |
| Existing 159 TypeScript errors in `apps/api` block compile | Was high; now resolved per `milestone/infra-local/v0.1.0` (2026-05-25) | High if regressed | Verify `tsc --noEmit` is green on this branch before starting. |
| `RUN_HOST` IAM scope creep | Medium | Medium | Scope `iam:PassRole` strictly to runner instance profile ARN; review with SRE before prod merge. |

## 17. Out of Scope — Explicit Boundary

To prevent scope creep during implementation:

- **No** auto-scaling logic, even behind a feature flag.
- **No** UI for CUSTOM runners. The dashboard's existing per-org `Runners.tsx` continues to handle CUSTOM/per-org runner CRUD via the org-scoped endpoints.
- **No** SSE log streaming. Polling is sufficient for MVP.
- **No** "rebalance load" actions. Operators see scores; they don't trigger redistribution.
- **No** historical job records beyond Redis TTL.
- **No** changes to the existing `Runners.tsx` page or its components.
- **No** changes to `apps/infra/sst.config.ts` in this PR; the IAM additions get a separate IaC change that lands before prod rollout.

## 18. Ordered Implementation Checklist

This list is the canonical "what to do next" — execute top to bottom.

### Prerequisites

- [ ] **P1**: Add `role: SystemRole` to `UserDto` + `fromUser()`. Verify swagger output.
- [ ] **P2**: Regenerate `@boxlite-ai/api-client`. Verify `User` type has `role`.
- [ ] **P3a**: Implement `useCurrentUser()` hook. Confirm whether a similar fetch already exists.
- [ ] **P3b**: Add `RequireAdmin` component and `RoutePath.ADMIN_RUNNER_OPS`.

### Lib extraction

- [ ] Create `apps/infra/lib/runner-ops-types.ts` with shared types.
- [ ] Create `apps/infra/lib/add-shared-runner-lib.ts`. Move logic from `apps/infra/scripts/add-shared-runner.ts` lines 505–680 into `async function* addSharedRunner(opts)`. Yield typed `ProgressEvent`s instead of writing to stderr.
- [ ] Create `apps/infra/lib/scale-down-runner-lib.ts`. Move logic from `apps/infra/scripts/scale-down-runner.ts` lines 490–820 into `async function* scaleDownRunner(opts)`.
- [ ] Reduce `apps/infra/scripts/add-shared-runner.ts` to argv parsing + lib iteration + stderr printing + exit code mapping.
- [ ] Reduce `apps/infra/scripts/scale-down-runner.ts` similarly.
- [ ] Run the existing CLI invocations from `docs/runner-scaling/README.md` §2.1, §2.2, §2.3 manually and confirm identical stderr output and identical JSON result files. **Gate**: do not move on until this passes.

### API integration

- [ ] Add `findAllFull({ regionType? })` argument to `RunnerService.findAllFull`. Add unit test.
- [ ] Create `apps/api/src/admin/services/runner-ops-job-store.ts`. Unit-test against a real Redis (TestContainers).
- [ ] Create `apps/api/src/admin/services/runner-ops.service.ts`. Mock the libs; unit-test lock + lifecycle.
- [ ] Create `apps/api/src/admin/dto/runner-ops.dto.ts`.
- [ ] Create `apps/api/src/admin/controllers/runner-ops.controller.ts` with `@RequiredSystemRole(SystemRole.ADMIN)` on every handler.
- [ ] Update `apps/api/src/admin/admin.module.ts`.
- [ ] Regenerate `@boxlite-ai/api-client`. Verify new endpoints + DTOs are present.
- [ ] Smoke-test via curl: list shared → add → poll job → list shared → scale-down → poll job → list shared (gone).

### Dashboard

- [ ] Add `apps/dashboard/src/hooks/useRunnerOpsJob.ts` with 2 s polling and unmount cancellation.
- [ ] Create `apps/dashboard/src/components/admin/RunnerOpsTable.tsx`.
- [ ] Create `apps/dashboard/src/components/admin/AddSharedRunnerDialog.tsx` with form validation.
- [ ] Create `apps/dashboard/src/components/admin/ScaleDownDialog.tsx` with live progress.
- [ ] Create `apps/dashboard/src/pages/admin/RunnerOps.tsx` that composes the above.
- [ ] Wire the route in `App.tsx` (wrap in `<RequireAdmin>`).
- [ ] Add a sidebar entry guarded by `isPlatformAdmin`.

### Tests

- [ ] Snapshot test for CLI output unchanged after refactor (under `apps/infra/scripts/__tests__/`).
- [ ] Lib unit tests with mocked AWS SDK + fetch.
- [ ] Service unit tests with mocked lib generator + in-memory job store.
- [ ] Controller integration test with real Redis.
- [ ] Component tests for the three dialogs.

### End-to-end and docs

- [ ] Local dogfood e2e in `apps/infra-local` Foundation: add → use → scale-down via UI.
- [ ] Write `docs/runner-scaling/runner-ops-ui-runbook.md` (English).
- [ ] Update `docs/runner-scaling/README.md` index to point to the runbook.
- [ ] Update this design doc's status to **Implemented** with a link to the merged PR.
- [ ] Prepare a separate follow-up issue for the IAM/SST changes needed for production rollout.

## 19. Open Questions

These do not block the spec, but should be confirmed during implementation:

1. **`useCurrentUser` shape**: does `apps/dashboard` already load `/users/me` somewhere we missed? If so, extend that source rather than creating a parallel hook.
2. **Sidebar location**: which file owns the dashboard's left navigation? Need to discover during dashboard work; a `grep "RoutePath.SANDBOXES"` should locate it.
3. **Admin token surface**: should `apps/api` self-loopback for `POST /admin/runners` use a dedicated runtime-scoped admin token or reuse the SST-stored `AdminApiKey`? Decision impacts secret rotation policy.
4. **Region selection in `AddSharedRunnerDialog`**: should it show all regions or only SHARED regions? The list endpoint and filter need a tiny extension.
5. **Telemetry**: do we emit a `runner_ops.job.completed` metric, or rely solely on the existing audit log? Leaning on audit for MVP; metric can be added later.

## 20. References

- `docs/apps/BoxLite cloud MVP.md` — MVP scope this implementation services.
- `docs/runner-scaling/scale-down-design.md` — full scale-down flow (this spec consumes it as a black box).
- `docs/runner-scaling/README.md` — runner-scaling docs index, scripts inventory, validation history.
- `docs/runner-scaling/e2e-multi-sandbox-report-v5.md` — most recent successful end-to-end of scale-down.
- `docs/superpowers/specs/2026-05-21-add-runner-script-design.md` — predecessor design for the CUSTOM runner CLI.
- `apps/api/src/admin/controllers/runner.controller.ts` — existing admin runner CRUD that this spec extends.
- `apps/api/src/sandbox/services/runner.service.ts` — runner state machine, TOPSIS scoring, draining/decommission flow.

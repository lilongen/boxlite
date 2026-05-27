# Design: Runner Ops Infra Provider Abstraction + LocalProcessInfraProvider

**Status:** Draft (2026-05-27)
**Scope:** P0 #1 (`IInfraProvider` abstraction + `LocalProcessInfraProvider`) + #2 (cargoTomlPath bug) + #3 (scale-down dryRun no-peer semantics). P0 #4 (error recovery: force-detach + target-runner-id) is a sequenced follow-on, NOT in this spec.
**Branch:** `feat/cloud-mvp-runner-auto-scaling` (feature) — build/test via the converged `integration/infra-local-and-runner-scale` worktree or the runner-scaling worktree (which has submodules + the built backup runner stack).
**Predecessors:**
- `docs/superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md` (the runner-ops wrapper)
- `docs/runner-scaling/scale-down-design.md` (10-stage scale-down + backup FFI)
- memory `project_runner_ops_curl_on_infra_local` (Phase A/B validation, infra-local component facts)

---

## 1. Goal

Make the runner-ops `add` operation work on infra-local by abstracting "create/destroy a runner host" behind a pluggable `IInfraProvider`, with two implementations:

- **`AwsInfraProvider`** — the existing EC2 logic (RunInstances + tag-based terminate), refactored out of the libs unchanged.
- **`LocalProcessInfraProvider`** — spawns a native `boxlite-runner` process (the model the operator confirmed: multiple native runners on one Mac via distinct `BOXLITE_HOME`), no Lima/EC2.

Result: the same wrapper drives `add` + `scale-down` end-to-end **locally** (native processes) and in **production** (EC2), and the provider becomes the actuation layer a future autoscaler will call.

## 2. Non-Goals (scope boundary)

- **No autoscaling decision logic.** This is the actuation layer only.
- **No P0 #4** (force-detach error-state sandboxes / `--target-runner-id`). Sequenced as a separate spec right after; it is scale-down hardening orthogonal to the provider abstraction and touches apps/api core.
- **No new AWS behavior.** `AwsInfraProvider` is a verbatim refactor of the current EC2 code (plus the #2 bug fix). AWS provisioning is not re-validated in this work.
- **No dashboard UI.** Server-side wrapper + CLI only (curl/CLI driven), per the prior scope decision.
- **No supervisor/launchd** for local runners — detached daemon only (crash = stays dead until re-added; acceptable for MVP).

## 3. Current State

`apps/infra/lib/add-shared-runner-lib.ts` hardcodes EC2:
- Stage 4 (`buildRunnerUserData`) + Stage 5 (`launchRunnerEc2` → `resolveUbuntuAmi` + `RunInstancesCommand` + `DescribeInstancesCommand`) — EC2-specific.
- Stages 1-3 (probe admin auth, generate apiKey, `POST /v1/admin/runners` to create the runner row) and 6-7 (poll readiness via the API) — provider-agnostic.

`apps/infra/lib/scale-down-runner-lib.ts` stage 10 (`DescribeInstancesCommand` by `tag:RunnerId` + `TerminateInstancesCommand`) — EC2-specific. Stages 1-9 (cordon, enumerate, stop, backup, archive, restart-on-peer, drain, delete row) — provider-agnostic.

`RunnerOpsService` (apps/api) consumes the libs via the `runAddSharedRunner` / `runScaleDownRunner` seams.

Known bug (#2): `add-shared-runner-lib.ts:268` sets `const cargoTomlPath = ''`; `runner-user-data.ts:44` does `input.cargoTomlPath ?? resolve(cwd, "../../Cargo.toml")` — empty string is not nullish so `??` does not default → `readFileSync('')` → `ENOENT`. The original CLI computed the path from `REPO_ROOT`; the lib extraction lost it.

Known semantics gap (#3): scale-down `dryRun` returns SUCCESS even when `peerCount === 0`, because the no-peer assertion sits AFTER the dryRun early-return. Misleading — a real scale-down with no peer cannot migrate.

infra-local facts (from memory `project_runner_ops_curl_on_infra_local`): native runner binary `/tmp/boxlite-runner-backup` (backup-FFI build); MinIO `boxlite` bucket at `http://127.0.0.1:29000` (minioadmin/minioadmin); registry `127.0.0.1:25000`; admin key `local-dev-admin-key`; SHARED region `us`. Backup env the runner needs: `BOXLITE_BACKUPS_BUCKET`, `BOXLITE_BACKUPS_ENDPOINT`, `BOXLITE_BACKUPS_REGION`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. **scale-down migration requires API crons ON** (job dispatch).

## 4. IInfraProvider Interface

New directory `apps/infra/lib/infra-provider/`.

`types.ts`:

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export interface RunnerHostSpec {
  /** Tags/names the host so terminate/describe can re-find it. */
  runnerId: string
  /** Token the runner self-registers with (BOXLITE_RUNNER_TOKEN). */
  apiKey: string
  /** API base the runner reports to (no /api suffix expected by callers; see provider). */
  apiUrl: string
  regionId: string
  /** AWS instance type; ignored by LocalProcess. */
  instanceType?: string
  /** Root disk GB; AWS only. */
  diskGb?: number
}

export interface ProvisionResult {
  /** Optional runtime info (e.g. LocalProcess port, EC2 private IP). Informational only. */
  endpoint?: string
}

export interface DescribeResult {
  alive: boolean
}

export interface IInfraProvider {
  /** Create a runner host, marking it with spec.runnerId. Returns when the host is launched
   *  (NOT when the runner is READY — readiness is polled by the orchestration via the API). */
  provisionRunner(spec: RunnerHostSpec): Promise<ProvisionResult>
  /** Find the host by runnerId and destroy it. Idempotent (no-op if already gone). */
  terminateRunner(runnerId: string): Promise<void>
  /** Find the host by runnerId; report whether it still exists/runs. */
  describeRunner(runnerId: string): Promise<DescribeResult>
}
```

**Symmetry principle:** the provider self-manages the runnerId↔resource link. Provision marks the resource with runnerId (EC2: `tag:RunnerId`; Local: home dir named by runnerId). Terminate/describe re-find by runnerId. The orchestration never stores an external id — it always passes runnerId. No DB migration, no side-store.

The runner DB row (`POST /admin/runners`) is created by the **orchestration** (provider-agnostic), before `provisionRunner`. The provider only creates/destroys the host.

## 5. AwsInfraProvider

`apps/infra/lib/infra-provider/aws.ts` — moves the existing EC2 code out of `add-shared-runner-lib.ts` and `scale-down-runner-lib.ts` verbatim:

- `provisionRunner(spec)`: `buildRunnerUserData({ runnerId, apiKey, apiUrl, registryUrl, withBackupSidecar, cargoTomlPath })` → `RunInstancesCommand` (tags `RunnerId=spec.runnerId`, `Name`, `BoxliteRole`) → `DescribeInstancesCommand` for IP. Returns `{ endpoint: privateIp }`.
- `terminateRunner(runnerId)`: `DescribeInstancesCommand({ Filters: [tag:RunnerId=runnerId] })` → `TerminateInstancesCommand(ids)`. No-op if none found.
- `describeRunner(runnerId)`: same describe → `alive = any non-terminated instance`.

Constructor takes the AWS-specific config (`awsRegion`, `subnetId`, `instanceProfileName`, `registryUrl`, `cargoTomlPath`).

**#2 fix:** `cargoTomlPath` is resolved by the AwsInfraProvider from config (`BOXLITE_RUNNER_OPS_CARGO_TOML`, default: resolve repo-root `Cargo.toml` from a known anchor), never empty string. A unit test asserts the resolved path is non-empty and points at an existing file.

## 6. LocalProcessInfraProvider

`apps/infra/lib/infra-provider/local.ts`.

- **Handle = home dir**: `<homeRoot>/<runnerId>/` where `homeRoot = config.localHomeRoot` (default `~/.boxlite-runner-ops`).
- **`provisionRunner(spec)`**:
  1. `mkdir -p <home>`.
  2. Pick a free TCP port: scan from `config.localPortBase` (default 3100) upward, skipping ports already `LISTEN` (via a `net` probe), and skipping ports recorded in sibling `meta.json` files (avoid two concurrent provisions picking the same port).
  3. Detached spawn `config.localRunnerBin` with `{ detached: true, stdio: ['ignore', <home>/runner.log fd, <same fd>] }`, then `child.unref()`. Env:
     - `BOXLITE_HOME_DIR=<home>`
     - `API_PORT=<port>`, `API_VERSION=2`, `RUNNER_DOMAIN=127.0.0.1`
     - `BOXLITE_RUNNER_TOKEN=spec.apiKey`
     - `BOXLITE_API_URL=spec.apiUrl` (must be the form the runner expects, e.g. `http://localhost:<apiPort>/api`)
     - `INSECURE_REGISTRIES=config.localInsecureRegistries`
     - `AWS_REGION=config.backupRegion`
     - `BOXLITE_BACKUPS_BUCKET/ENDPOINT/REGION`, `AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY` from config (backup → MinIO)
     - `DYLD_LIBRARY_PATH=config.localDyld` (if set)
  4. Write `<home>/meta.json`: `{ runnerId, pid, port, startedAt }`.
  5. Return `{ endpoint: "http://127.0.0.1:<port>" }`.
- **`terminateRunner(runnerId)`**: read `<home>/meta.json`; if missing, no-op. `process.kill(pid, 'SIGTERM')`; poll up to `config.localTerminateGraceSec` (default 15s) for the pid to exit (`kill(pid,0)` throws ESRCH); if still alive, `SIGKILL`. Then `rm -rf <home>`.
- **`describeRunner(runnerId)`**: read meta.json; `alive = pid present && kill(pid,0) succeeds`.

Constructor takes the local config (`localHomeRoot`, `localPortBase`, `localRunnerBin`, `localDyld`, `localInsecureRegistries`, backup env, `localTerminateGraceSec`).

Stale-pid guard: if `meta.json` exists but the pid is dead (`describeRunner` false), `provisionRunner` for the same runnerId is not expected (each runnerId is provisioned once); `terminateRunner` on a dead pid just cleans the home.

## 7. Provider Selection + Orchestration Wiring

- **Selection**: `RunnerOpsService` reads `config.runnerOps.provider` (`'aws' | 'local'`, default `'aws'`) and constructs the matching provider once (a small `createInfraProvider(config)` factory in `infra-provider/factory.ts`).
- **Lib signature change**: the generator libs take the provider as a parameter:
  ```typescript
  export async function* addSharedRunner(opts: AddSharedRunnerOpts, provider: IInfraProvider): AsyncGenerator<ProgressEvent, AddSharedRunnerResult, void>
  export async function* scaleDownRunner(opts: ScaleDownOpts, provider: IInfraProvider): AsyncGenerator<ProgressEvent, ScaleDownResult, void>
  ```
  - `add` stages 4-5 → `yield {stage:4,...'provision host'}` then `await provider.provisionRunner({ runnerId, apiKey, apiUrl: opts.apiUrl, regionId, instanceType, diskGb })`. The EC2-specific user-data/AMI/RunInstances code is GONE from the lib (now in AwsInfraProvider).
  - `scale-down` stage 10 → `await provider.terminateRunner(opts.runnerId)`. Rename the existing `skipEc2Terminate` flag to the provider-agnostic `skipTerminate` (a debug flag that skips the `provider.terminateRunner` call entirely, leaving the host running); keep `skipEc2Terminate` as a deprecated alias in the CLI/DTO for back-compat.
- **Service**: `runAddSharedRunner(opts)` / `runScaleDownRunner(opts)` seams pass `this.provider` into the lib.
- **CLI shells** (`apps/infra/scripts/*.ts`): construct the provider from CLI/env (`--provider` or `BOXLITE_RUNNER_OPS_PROVIDER`), pass into the lib. Default `aws` → CLI behaviour unchanged for existing AWS operators.

`apps/api/src/admin/admin.module.ts`: provide the `IInfraProvider` instance via the factory (or have `RunnerOpsService` build it from `TypedConfigService` in its constructor).

## 8. Scale-down dryRun no-peer fix (#3)

In `scale-down-runner-lib.ts`, move the `if (peers.length === 0) throw new Error('no peer SHARED runner in region ...')` assertion to BEFORE the `if (opts.dryRun) return ...` early-return. Net: dryRun with 0 peers → the generator throws → job FAILED with a clear "no peer" error, signalling the runner cannot be scaled down. dryRun with ≥1 peer → still returns the preflight result as SUCCESS.

## 9. Configuration

`apps/api/src/config/configuration.ts` `runnerOps` section additions:

```typescript
runnerOps: {
  provider: env('BOXLITE_RUNNER_OPS_PROVIDER', 'aws'),       // 'aws' | 'local'
  apiUrl, adminToken, awsRegion,                             // existing
  // aws
  subnetId, instanceProfileName, registryUrl,                // existing
  cargoTomlPath: env('BOXLITE_RUNNER_OPS_CARGO_TOML', ''),   // '' → resolve default
  // local
  localRunnerBin: env('BOXLITE_RUNNER_OPS_LOCAL_RUNNER_BIN'),
  localDyld: env('BOXLITE_RUNNER_OPS_LOCAL_DYLD'),
  localHomeRoot: env('BOXLITE_RUNNER_OPS_LOCAL_HOME_ROOT', '~/.boxlite-runner-ops'),
  localPortBase: parseInt(env('BOXLITE_RUNNER_OPS_LOCAL_PORT_BASE', '3100'), 10),
  localInsecureRegistries: env('BOXLITE_RUNNER_OPS_LOCAL_INSECURE_REGISTRIES', '127.0.0.1:25000'),
  localTerminateGraceSec: parseInt(env('BOXLITE_RUNNER_OPS_LOCAL_TERMINATE_GRACE_SEC', '15'), 10),
  // backup (shared by local runner launch; aws sets via user-data already)
  backupBucket: env('BOXLITE_RUNNER_OPS_BACKUP_BUCKET'),
  backupEndpoint: env('BOXLITE_RUNNER_OPS_BACKUP_ENDPOINT'),
  backupRegion: env('BOXLITE_RUNNER_OPS_BACKUP_REGION', 'us-east-1'),
  backupAccessKey: env('BOXLITE_RUNNER_OPS_BACKUP_ACCESS_KEY'),
  backupSecretKey: env('BOXLITE_RUNNER_OPS_BACKUP_SECRET_KEY'),
},
```

Match the project's actual config helper (`env(...)` shape may differ — adapt to the existing `configuration.ts` pattern).

## 10. File Structure

New:
- `apps/infra/lib/infra-provider/types.ts` — `IInfraProvider`, `RunnerHostSpec`, results
- `apps/infra/lib/infra-provider/aws.ts` — `AwsInfraProvider` (EC2 code moved from libs + cargoTomlPath fix)
- `apps/infra/lib/infra-provider/local.ts` — `LocalProcessInfraProvider`
- `apps/infra/lib/infra-provider/factory.ts` — `createInfraProvider(config): IInfraProvider`
- `apps/infra/lib/infra-provider/__tests__/local.test.ts`, `aws.test.ts`, `factory.test.ts`

Modified:
- `apps/infra/lib/add-shared-runner-lib.ts` — drop EC2 code; take `provider`; stages 4-5 → `provider.provisionRunner`
- `apps/infra/lib/scale-down-runner-lib.ts` — drop EC2 code; take `provider`; stage 10 → `provider.terminateRunner`; move no-peer assertion before dryRun return (#3)
- `apps/infra/lib/runner-ops-types.ts` — add `provider?` not needed; opts unchanged
- `apps/infra/scripts/add-shared-runner.ts`, `scale-down-runner.ts` — construct provider, pass to lib
- `apps/api/src/admin/services/runner-ops.service.ts` — build provider from config, pass into seams
- `apps/api/src/config/configuration.ts` — runnerOps additions
- `apps/api/src/admin/admin.module.ts` — provider wiring (if not constructed inside the service)

## 11. Testing Strategy

Unit tests written (jest can't run on this branch — Foundation gap; verified via `tsc --noEmit` + manual E2E):
- `LocalProcessInfraProvider`: mock `fs` + `child_process.spawn` + `net` port probe → provision creates home + writes meta + spawns with correct env; terminate reads meta, signals pid, rm home; describe checks pid; port scan skips in-use.
- `AwsInfraProvider`: mock `@aws-sdk/client-ec2` → provision tags RunInstances with RunnerId; terminate filters by tag + terminates; cargoTomlPath resolves non-empty.
- `factory`: returns AwsInfraProvider for 'aws', LocalProcessInfraProvider for 'local'.
- scale-down lib: dryRun with 0 peers → throws (FAILED).
- CLI snapshot tests still pass (provider param default 'aws' preserves AWS CLI behaviour).

**Manual E2E (infra-local, the P0#1 acceptance) — all via the wrapper, no manual runner launch:**
1. Start the runner-ops API with `BOXLITE_RUNNER_OPS_PROVIDER=local` + local config (`LOCAL_RUNNER_BIN=/tmp/boxlite-runner-backup`, backup MinIO env, `DYLD`), crons ON.
2. `POST /admin/runner-ops/add-shared` → job → `LocalProcessInfraProvider` spawns a native runner → poll job SUCCESS + runner READY.
3. `POST /admin/runner-ops/add-shared` again → second native runner (peer).
4. Create a box (ubuntu:22.04, admin org) → lands on a runner.
5. `POST /admin/runner-ops/:id/scale-down` → box migrates to peer (backup→MinIO→restore) → `LocalProcessInfraProvider.terminateRunner` kills the source process + rm home → job SUCCESS.
6. Verify: box on peer + sandbox.id preserved; source runner row deleted; source process gone (`kill -0` fails); source home removed.

Acceptance: the full local add → use → scale-down loop runs entirely through the wrapper API (contrast with the prior Phase B where runners were launched/killed manually).

## 12. Effort Estimate

| Day | Focus |
| --- | --- |
| 1 | `infra-provider/{types,factory}` + `AwsInfraProvider` (move EC2 code + #2 fix) + unit tests; refactor the two libs to take `provider` (AWS path green via CLI snapshot) |
| 2 | `LocalProcessInfraProvider` (provision/terminate/describe + port scan + meta) + unit tests; service + config + CLI wiring; #3 dryRun fix |
| 3 | Manual E2E on infra-local (provider=local): add → add → box → scale-down migrate, all via wrapper; fix integration issues |

~3 solo days. Risk buffer +0.5d for the local launch env (DYLD / backup env / readiness timing).

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Local runner launch env incomplete (backup/DYLD/registry) → runner unhealthy or backup fails | Reuse the exact env set validated in Phase B (memory has it); config defaults match infra-local |
| Port scan race (two concurrent provisions pick same port) | Skip ports in sibling meta.json + the per-kind Redis add-lock already serializes adds |
| Detached spawn not surviving Node parent exit | `detached:true` + `unref()` + setsid semantics; verified by the manual Phase B nohup launches |
| crons-off blocks scale-down (known) | E2E runbook requires crons ON; documented |
| Refactor changes AWS CLI behaviour | CLI snapshot test + provider default 'aws' |
| Lib signature change (`provider` param) ripples to callers | Only 2 callers each (service seam + CLI); both updated in this spec |

## 14. Out of Scope / Sequenced Next

- **P0 #4** (force-detach error-state sandboxes blocking runner DELETE; `--target-runner-id` for deterministic peer selection) — separate spec immediately after.
- AWS-side re-validation of `add`/`scale-down` (the libs stay EC2-capable; not exercised here).
- Foundation: jest preset + api-client regen (blocks running the unit tests).
- Autoscaler decision loop (this provider is its actuation layer).

## 15. Open Questions

1. **apiUrl form for the local runner**: the runner expects `BOXLITE_API_URL=http://localhost:<apiPort>/api`. The `RunnerHostSpec.apiUrl` passed by the service is `config.runnerOps.apiUrl`. Confirm during implementation that this carries the `/api` suffix the runner needs (Phase B used `http://localhost:3009/api`). If the lib's API calls expect no-suffix while the runner needs suffix, the provider appends `/api` for the runner env.
2. **Where the provider is constructed** (inside `RunnerOpsService` from `TypedConfigService`, vs a Nest DI provider in `admin.module`): pick the one matching existing patterns; default to constructing in the service (simplest, matches how it reads config today).

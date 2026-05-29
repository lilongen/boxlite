# Runner Ops Infra Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abstract "create/destroy a runner host" behind `IInfraProvider` with `AwsInfraProvider` (existing EC2 code, refactored) + `LocalProcessInfraProvider` (spawns native `boxlite-runner`), so the runner-ops wrapper drives add+scale-down end-to-end locally and on AWS. Fold in the cargoTomlPath bug (#2) and scale-down dryRun no-peer semantics (#3).

**Architecture:** New `apps/infra/lib/infra-provider/` (types + aws + local + factory). The two generator libs (`add-shared-runner-lib`, `scale-down-runner-lib`) drop their hardcoded EC2 calls and instead receive an `IInfraProvider`; `provisionRunner`/`terminateRunner` replace EC2 launch/terminate. Provider chosen by `BOXLITE_RUNNER_OPS_PROVIDER=aws|local`. Runner DB-row creation stays in orchestration. Verified by `tsc --noEmit` (jest blocked — Foundation gap) + a live infra-local E2E driven entirely through the wrapper API.

**Tech Stack:** TypeScript, `@aws-sdk/client-ec2`, Node `child_process`/`net`/`fs`, NestJS (apps/api), the backup-FFI runner binary `/tmp/boxlite-runner-backup`, MinIO, infra-local.

**Spec:** `docs/superpowers/specs/2026-05-27-runner-ops-localprocess-provider-design.md`

**Execution context:** runner-scaling worktree (`/Users/lilongen/github/boxlite-cloud-mvp-runner-auto-scaling`). It has submodules + the built backup runner stack + the `apps/apps` symlink + the `apps/.env` (provider config to be added). API runs via the rebuilt bundle on :3009 (nx serve blocked by 159 pre-existing TS errors; `node dist/apps/api/main.js`).

**Pre-flight:**
```bash
cd /Users/lilongen/github/boxlite-cloud-mvp-runner-auto-scaling
git status   # spec committed (1cf75ade); clean otherwise except gitignored .env/symlink/build.rs
ls /tmp/boxlite-runner-backup            # backup-capable runner binary present
ls target/debug/libboxlite.dylib         # FFI dylib present
```

---

## File Structure

New:
- `apps/infra/lib/infra-provider/types.ts` — `IInfraProvider`, `RunnerHostSpec`, `ProvisionResult`, `DescribeResult`, `InfraProviderConfig`
- `apps/infra/lib/infra-provider/aws.ts` — `AwsInfraProvider` (EC2 code moved from the libs + cargoTomlPath fix)
- `apps/infra/lib/infra-provider/local.ts` — `LocalProcessInfraProvider`
- `apps/infra/lib/infra-provider/factory.ts` — `createInfraProvider(config)`
- `apps/infra/lib/infra-provider/__tests__/{local,aws,factory}.test.ts`

Modified:
- `apps/infra/lib/add-shared-runner-lib.ts` — drop EC2 code; signature `(opts, provider)`; stages 4-5 → `provider.provisionRunner`
- `apps/infra/lib/scale-down-runner-lib.ts` — drop EC2 code; signature `(opts, provider)`; stage 10 → `provider.terminateRunner`; move no-peer assertion before dryRun return
- `apps/infra/lib/runner-ops-types.ts` — add `skipTerminate?` to ScaleDownOpts (alias of skipEc2Terminate)
- `apps/infra/scripts/add-shared-runner.ts`, `scale-down-runner.ts` — build provider from env/args, pass to lib
- `apps/api/src/admin/services/runner-ops.service.ts` — build provider from config, pass into seams
- `apps/api/src/config/configuration.ts` — runnerOps provider/local/backup config
- `apps/api/src/admin/dto/runner-ops.dto.ts` — `skipTerminate?` (keep `skipEc2Terminate?` alias)

## Conventions
- Conventional commits; no `Co-Authored-By` trailer.
- Jest can't run (Foundation gap) — write `*.test.ts` but verify with `tsc`. Compile check: `cd apps/infra && ../node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -v test.ts` for infra libs; `cd apps && ./node_modules/.bin/tsc -p api/tsconfig.app.json --noEmit` for api.
- `.js` extensions on relative imports in `apps/infra/lib` (nodenext, required by the apps/api build chain — established in the existing libs).
- Commit per task.

---

## Task 1: IInfraProvider types

**Files:** Create `apps/infra/lib/infra-provider/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export interface RunnerHostSpec {
  runnerId: string
  apiKey: string
  apiUrl: string
  regionId: string
  instanceType?: string
  diskGb?: number
  withBackupSidecar?: boolean
}

export interface ProvisionResult {
  endpoint?: string
}

export interface DescribeResult {
  alive: boolean
}

export interface IInfraProvider {
  provisionRunner(spec: RunnerHostSpec): Promise<ProvisionResult>
  terminateRunner(runnerId: string): Promise<void>
  describeRunner(runnerId: string): Promise<DescribeResult>
}

export interface AwsProviderConfig {
  kind: 'aws'
  awsRegion: string
  subnetId?: string
  instanceProfileName?: string
  registryUrl?: string
  cargoTomlPath?: string
}

export interface LocalProviderConfig {
  kind: 'local'
  runnerBin: string
  dyld?: string
  homeRoot: string
  portBase: number
  insecureRegistries: string
  terminateGraceSec: number
  apiUrl: string
  backupBucket?: string
  backupEndpoint?: string
  backupRegion: string
  backupAccessKey?: string
  backupSecretKey?: string
}

export type InfraProviderConfig = AwsProviderConfig | LocalProviderConfig
```

- [ ] **Step 2: Compile** — `cd /Users/lilongen/github/boxlite-cloud-mvp-runner-auto-scaling/apps/infra && ../node_modules/.bin/tsc --noEmit --strict false --module esnext --target es2022 --moduleResolution bundler --skipLibCheck lib/infra-provider/types.ts` → 0 errors.

- [ ] **Step 3: Commit** — `git add apps/infra/lib/infra-provider/types.ts && git commit -m "feat(infra): IInfraProvider interface + provider config types"`

---

## Task 2: AwsInfraProvider (move EC2 code + cargoTomlPath fix)

**Files:** Create `apps/infra/lib/infra-provider/aws.ts`; reference `apps/infra/lib/add-shared-runner-lib.ts` (lines ~176-243 launch/AMI) + `scale-down-runner-lib.ts` (EC2 terminate) for the code to move.

- [ ] **Step 1: Read the EC2 code to move**
```bash
sed -n '176,243p' apps/infra/lib/add-shared-runner-lib.ts
grep -n 'DescribeInstances\|TerminateInstances\|findEc2\|terminateEc2' apps/infra/lib/scale-down-runner-lib.ts
```

- [ ] **Step 2: Write AwsInfraProvider** — move `resolveUbuntuAmi`, `launchRunnerEc2`, and the scale-down EC2 find/terminate verbatim into the class. `provisionRunner` builds user-data (resolve cargoTomlPath from config, never empty) + RunInstances tagged `RunnerId`. `terminateRunner` describes by `tag:RunnerId` + terminates. `describeRunner` describes by tag → alive.

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from 'path'
import { EC2Client, RunInstancesCommand, DescribeImagesCommand, DescribeInstancesCommand, TerminateInstancesCommand, type _InstanceType } from '@aws-sdk/client-ec2'
import { buildRunnerUserData } from '../runner-user-data.js'
import type { IInfraProvider, RunnerHostSpec, ProvisionResult, DescribeResult, AwsProviderConfig } from './types.js'

const UBUNTU_OWNER_ID = '099720109477'
const UBUNTU_NAME_PATTERN = 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'

export class AwsInfraProvider implements IInfraProvider {
  private readonly client: EC2Client
  constructor(private readonly cfg: AwsProviderConfig) {
    this.client = new EC2Client({ region: cfg.awsRegion })
  }
  private cargoTomlPath(): string {
    // #2 fix: never empty. Use config or resolve repo-root Cargo.toml from this file's location.
    if (this.cfg.cargoTomlPath && this.cfg.cargoTomlPath.length > 0) return this.cfg.cargoTomlPath
    // apps/infra/lib/infra-provider/aws.ts → repo root is ../../../../
    return resolve(__dirname, '../../../../Cargo.toml')
  }
  async provisionRunner(spec: RunnerHostSpec): Promise<ProvisionResult> {
    const userDataBase64 = buildRunnerUserData({
      runnerId: spec.runnerId, apiKey: spec.apiKey, apiUrl: spec.apiUrl,
      registryUrl: this.cfg.registryUrl, withBackupSidecar: spec.withBackupSidecar ?? false,
      cargoTomlPath: this.cargoTomlPath(),
    })
    const imageId = await this.resolveUbuntuAmi()
    const run = await this.client.send(new RunInstancesCommand({
      ImageId: imageId, InstanceType: (spec.instanceType ?? 'c8i.2xlarge') as _InstanceType,
      IamInstanceProfile: this.cfg.instanceProfileName ? { Name: this.cfg.instanceProfileName } : undefined,
      UserData: userDataBase64, CpuOptions: { NestedVirtualization: 'enabled' } as any,
      NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: this.cfg.subnetId, AssociatePublicIpAddress: true }],
      BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: spec.diskGb ?? 100 } }],
      TagSpecifications: [{ ResourceType: 'instance', Tags: [
        { Key: 'Name', Value: spec.runnerId }, { Key: 'RunnerId', Value: spec.runnerId }, { Key: 'BoxliteRole', Value: 'runner-shared' },
      ] }],
      MinCount: 1, MaxCount: 1,
    }))
    const inst = run.Instances?.[0]
    if (!inst?.InstanceId) throw new Error('RunInstances returned no instance.')
    return { endpoint: inst.PrivateIpAddress ?? undefined }
  }
  async terminateRunner(runnerId: string): Promise<void> {
    const ids = await this.findByRunnerId(runnerId)
    if (ids.length > 0) await this.client.send(new TerminateInstancesCommand({ InstanceIds: ids }))
  }
  async describeRunner(runnerId: string): Promise<DescribeResult> {
    return { alive: (await this.findByRunnerId(runnerId)).length > 0 }
  }
  private async findByRunnerId(runnerId: string): Promise<string[]> {
    const d = await this.client.send(new DescribeInstancesCommand({ Filters: [{ Name: 'tag:RunnerId', Values: [runnerId] }] }))
    return (d.Reservations ?? []).flatMap((r) => (r.Instances ?? [])
      .filter((i) => i.InstanceId && i.State?.Name !== 'terminated' && i.State?.Name !== 'shutting-down')
      .map((i) => i.InstanceId!))
  }
  private async resolveUbuntuAmi(): Promise<string> {
    const r = await this.client.send(new DescribeImagesCommand({
      Owners: [UBUNTU_OWNER_ID],
      Filters: [{ Name: 'name', Values: [UBUNTU_NAME_PATTERN] }, { Name: 'architecture', Values: ['x86_64'] }],
    }))
    const imgs = (r.Images ?? []).filter((i) => i.ImageId && i.CreationDate).sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''))
    if (!imgs[0]?.ImageId) throw new Error('No Ubuntu Noble 24.04 AMI found.')
    return imgs[0].ImageId
  }
}
```

Note: if `buildRunnerUserData`'s signature differs, adapt the call to match `apps/infra/lib/runner-user-data.ts`. Keep `__dirname` working — if the lib is ESM and `__dirname` is unavailable, derive via `fileURLToPath(import.meta.url)` like the existing libs do.

- [ ] **Step 3: Write `aws.test.ts`** — mock `@aws-sdk/client-ec2`; assert provisionRunner tags RunInstances with `RunnerId`, terminateRunner filters by `tag:RunnerId` then terminates, cargoTomlPath() returns a non-empty existing path.

- [ ] **Step 4: Compile** (tsc infra) → 0 errors in aws.ts.

- [ ] **Step 5: Commit** — `git commit -m "feat(infra): AwsInfraProvider (EC2 logic moved from libs) + fix cargoTomlPath empty-string bug"`

---

## Task 3: LocalProcessInfraProvider

**Files:** Create `apps/infra/lib/infra-provider/local.ts` + `__tests__/local.test.ts`

- [ ] **Step 1: Write the test (provision/terminate/describe with mocked fs/spawn/net)**

```typescript
import { describe, it, expect, jest } from '@jest/globals'
// mock child_process.spawn, fs, net; assert:
//  - provisionRunner: mkdir home, picks free port (net probe), spawn detached with env containing
//    BOXLITE_HOME_DIR/<runnerId>, API_PORT=<port>, BOXLITE_RUNNER_TOKEN=apiKey, backup env; writes meta.json{pid,port}
//  - terminateRunner: reads meta, kills pid, rm home
//  - describeRunner: alive iff kill(pid,0) ok
```
(Full mock wiring per existing test patterns; reference `apps/infra/lib/__tests__/add-shared-runner-lib.test.ts`.)

- [ ] **Step 2: Implement LocalProcessInfraProvider**

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, openSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createServer } from 'net'
import type { IInfraProvider, RunnerHostSpec, ProvisionResult, DescribeResult, LocalProviderConfig } from './types.js'

interface RunnerMeta { runnerId: string; pid: number; port: number; startedAt: string }

export class LocalProcessInfraProvider implements IInfraProvider {
  constructor(private readonly cfg: LocalProviderConfig) {}
  private homeRoot(): string { return this.cfg.homeRoot.replace(/^~/, homedir()) }
  private home(runnerId: string): string { return join(this.homeRoot(), runnerId) }
  private metaPath(runnerId: string): string { return join(this.home(runnerId), 'meta.json') }

  async provisionRunner(spec: RunnerHostSpec): Promise<ProvisionResult> {
    const home = this.home(spec.runnerId)
    mkdirSync(home, { recursive: true })
    const port = await this.pickFreePort()
    const logFd = openSync(join(home, 'runner.log'), 'a')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BOXLITE_HOME_DIR: home,
      API_PORT: String(port),
      API_VERSION: '2',
      RUNNER_DOMAIN: '127.0.0.1',
      BOXLITE_RUNNER_TOKEN: spec.apiKey,
      BOXLITE_API_URL: spec.apiUrl,
      INSECURE_REGISTRIES: this.cfg.insecureRegistries,
      AWS_REGION: this.cfg.backupRegion,
      BOXLITE_BACKUPS_BUCKET: this.cfg.backupBucket,
      BOXLITE_BACKUPS_ENDPOINT: this.cfg.backupEndpoint,
      BOXLITE_BACKUPS_REGION: this.cfg.backupRegion,
      AWS_ACCESS_KEY_ID: this.cfg.backupAccessKey,
      AWS_SECRET_ACCESS_KEY: this.cfg.backupSecretKey,
      ...(this.cfg.dyld ? { DYLD_LIBRARY_PATH: this.cfg.dyld } : {}),
    }
    const child = spawn(this.cfg.runnerBin, [], { detached: true, stdio: ['ignore', logFd, logFd], env })
    child.unref()
    const meta: RunnerMeta = { runnerId: spec.runnerId, pid: child.pid!, port, startedAt: new Date().toISOString() }
    writeFileSync(this.metaPath(spec.runnerId), JSON.stringify(meta, null, 2))
    return { endpoint: `http://127.0.0.1:${port}` }
  }

  async terminateRunner(runnerId: string): Promise<void> {
    const meta = this.readMeta(runnerId)
    if (!meta) return
    try { process.kill(meta.pid, 'SIGTERM') } catch { /* already gone */ }
    const deadline = Date.now() + this.cfg.terminateGraceSec * 1000
    while (Date.now() < deadline) {
      if (!this.pidAlive(meta.pid)) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (this.pidAlive(meta.pid)) { try { process.kill(meta.pid, 'SIGKILL') } catch { /* */ } }
    rmSync(this.home(runnerId), { recursive: true, force: true })
  }

  async describeRunner(runnerId: string): Promise<DescribeResult> {
    const meta = this.readMeta(runnerId)
    return { alive: !!meta && this.pidAlive(meta.pid) }
  }

  private readMeta(runnerId: string): RunnerMeta | null {
    const p = this.metaPath(runnerId)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as RunnerMeta
  }
  private pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
  private pickFreePort(): Promise<number> {
    const base = this.cfg.portBase
    const tryPort = (port: number): Promise<boolean> => new Promise((res) => {
      const srv = createServer()
      srv.once('error', () => res(false))
      srv.once('listening', () => srv.close(() => res(true)))
      srv.listen(port, '127.0.0.1')
    })
    return (async () => {
      for (let p = base; p < base + 200; p++) { if (await tryPort(p)) return p }
      throw new Error(`No free port near ${base}`)
    })()
  }
}
```

- [ ] **Step 3: Compile** (tsc infra) → 0 errors.

- [ ] **Step 4: Commit** — `git commit -m "feat(infra): LocalProcessInfraProvider (detached native runner spawn + home-dir handle)"`

---

## Task 4: Factory + config types wiring

**Files:** Create `apps/infra/lib/infra-provider/factory.ts` + `__tests__/factory.test.ts`

- [ ] **Step 1: factory**
```typescript
// SPDX-License-Identifier: AGPL-3.0-only
import type { IInfraProvider, InfraProviderConfig } from './types.js'
import { AwsInfraProvider } from './aws.js'
import { LocalProcessInfraProvider } from './local.js'

export function createInfraProvider(cfg: InfraProviderConfig): IInfraProvider {
  if (cfg.kind === 'local') return new LocalProcessInfraProvider(cfg)
  return new AwsInfraProvider(cfg)
}
```
- [ ] **Step 2: factory.test.ts** — asserts 'local' → LocalProcessInfraProvider, 'aws' → AwsInfraProvider.
- [ ] **Step 3: Compile + Commit** — `git commit -m "feat(infra): infra-provider factory"`

---

## Task 5: Refactor add-shared-runner-lib to use provider

**Files:** Modify `apps/infra/lib/add-shared-runner-lib.ts`

- [ ] **Step 1:** Change signature to `export async function* addSharedRunner(opts: AddSharedRunnerOpts, provider: IInfraProvider)`. Import `IInfraProvider` from `./infra-provider/types.js`. Remove `EC2Client`/`RunInstances`/`DescribeImages`/`resolveUbuntuAmi`/`launchRunnerEc2`/`buildRunnerUserData` import + functions (now in AwsInfraProvider).

- [ ] **Step 2:** Replace stages 4-5 with:
```typescript
yield { type: 'stage', stage: 4, total: 7, label: 'Provision runner host' }
checkAborted(opts.signal)
const prov = await provider.provisionRunner({
  runnerId: created.id, apiKey: runnerApiKey, apiUrl: opts.apiUrl,
  regionId, instanceType: opts.instanceType, diskGb: opts.diskGb, withBackupSidecar: opts.withBackupSidecar,
})
yield { type: 'data', key: 'ec2InstanceId', value: prov.endpoint ?? '' }
yield { type: 'log', line: `host provisioned: ${prov.endpoint ?? '(no endpoint)'}` }
```
Keep stages 1-3 (probe auth, gen key, POST /admin/runners) and 6-7 (poll readiness) unchanged.

- [ ] **Step 3:** Update the lib test `add-shared-runner-lib.test.ts` to pass a mock provider (`{ provisionRunner: jest.fn().mockResolvedValue({endpoint:'10.0.0.1'}), terminateRunner: jest.fn(), describeRunner: jest.fn() }`) and drop the EC2 mock.

- [ ] **Step 4: Compile** (tsc infra, non-test) → 0 errors.

- [ ] **Step 5: Commit** — `git commit -m "refactor(infra): addSharedRunner uses IInfraProvider instead of hardcoded EC2"`

---

## Task 6: Refactor scale-down-runner-lib + dryRun fix (#3)

**Files:** Modify `apps/infra/lib/scale-down-runner-lib.ts`, `runner-ops-types.ts`

- [ ] **Step 1:** Add `skipTerminate?: boolean` to `ScaleDownOpts` in runner-ops-types.ts (keep `skipEc2Terminate?` as alias).

- [ ] **Step 2:** Change signature `scaleDownRunner(opts, provider: IInfraProvider)`. Remove EC2 imports + `findEc2ByRunnerId`/`terminateEc2`.

- [ ] **Step 3 (#3 fix):** Move the no-peer assertion to BEFORE the `if (opts.dryRun) return`:
```typescript
// stage 1 preflight, after computing peers:
if (peers.length === 0) throw new Error(`no peer SHARED runner (ready, schedulable) in region ${src.region}; cannot scale down`)
yield { type: 'data', key: 'peerCount', value: peers.length }
if (opts.dryRun) { return { runnerId: opts.runnerId, sandboxesMigrated: [], sandboxesArchived: [], ec2InstancesTerminated: [], durationMs: Date.now() - start } }
```

- [ ] **Step 4:** Replace stage 10:
```typescript
const skip = opts.skipTerminate ?? opts.skipEc2Terminate ?? false
let terminated: string[] = []
if (!skip) {
  yield { type: 'stage', stage: 10, total: 10, label: 'terminate runner host' }
  await provider.terminateRunner(opts.runnerId)
  terminated = [opts.runnerId]
} else {
  yield { type: 'stage', stage: 10, total: 10, label: 'skipTerminate: leaving host running' }
}
// ec2InstancesTerminated kept for back-compat; now holds runnerId(s) terminated
```

- [ ] **Step 5:** Update `scale-down-runner-lib.test.ts`: pass mock provider; add a test that dryRun with 0 peers throws.

- [ ] **Step 6: Compile + Commit** — `git commit -m "refactor(infra): scaleDownRunner uses IInfraProvider; dryRun fails on no-peer (#3)"`

---

## Task 7: API config + RunnerOpsService wiring

**Files:** Modify `apps/api/src/config/configuration.ts`, `apps/api/src/admin/services/runner-ops.service.ts`

- [ ] **Step 1:** Add the runnerOps provider/local/backup config (per spec §9), matching the existing config helper pattern in configuration.ts.

- [ ] **Step 2:** In `RunnerOpsService`, build the provider in the constructor:
```typescript
import { createInfraProvider } from '../../../../infra/lib/infra-provider/factory.js'
import type { IInfraProvider, InfraProviderConfig } from '../../../../infra/lib/infra-provider/types.js'
// in constructor:
this.provider = createInfraProvider(this.buildProviderConfig())
// buildProviderConfig(): reads configService.get('runnerOps.*') → AwsProviderConfig|LocalProviderConfig
```
Update the `runAddSharedRunner`/`runScaleDownRunner` seams to pass `this.provider` into the libs.

- [ ] **Step 3: Compile** (tsc api) → 0 new errors in runner-ops.service / configuration.

- [ ] **Step 4: Commit** — `git commit -m "feat(admin): RunnerOpsService builds IInfraProvider from config (aws|local)"`

---

## Task 8: CLI shells pass provider

**Files:** Modify `apps/infra/scripts/add-shared-runner.ts`, `scale-down-runner.ts`

- [ ] **Step 1:** In each CLI, after parseArgs, build the provider from env (`BOXLITE_RUNNER_OPS_PROVIDER`, default 'aws') + the relevant config from env/args, and pass it as the 2nd arg to the lib generator. Default 'aws' preserves existing CLI behaviour.

- [ ] **Step 2:** Run `--help` on both → unchanged. Re-seed CLI snapshot tests if they assert help text.

- [ ] **Step 3: Compile + Commit** — `git commit -m "refactor(infra): CLI shells construct IInfraProvider (default aws)"`

---

## Task 9: DTO skipTerminate alias

**Files:** Modify `apps/api/src/admin/dto/runner-ops.dto.ts`

- [ ] **Step 1:** Add `skipTerminate?: boolean` to `ScaleDownRequestDto` (keep `skipEc2Terminate?`). In `RunnerOpsService.startScaleDownRunner`, map both into the opts.
- [ ] **Step 2: Compile + Commit** — `git commit -m "feat(admin): scale-down skipTerminate flag (skipEc2Terminate alias)"`

---

## Task 10: Live E2E on infra-local (provider=local) — acceptance

**Files:** none (runtime); update `apps/.env`.

- [ ] **Step 1: Rebuild API bundle** — `cd apps && NX_DAEMON=false corepack yarn nx build api --skip-nx-cache` (159 TS errors expected; bundle emits). Confirm `dist/apps/api/main.js` fresh.

- [ ] **Step 2: Configure provider=local in `apps/.env`** (gitignored):
```
BOXLITE_RUNNER_OPS_PROVIDER=local
BOXLITE_RUNNER_OPS_LOCAL_RUNNER_BIN=/tmp/boxlite-runner-backup
BOXLITE_RUNNER_OPS_LOCAL_DYLD=/Users/lilongen/github/boxlite-cloud-mvp/sdks/go
BOXLITE_RUNNER_OPS_LOCAL_HOME_ROOT=~/.boxlite-runner-ops
BOXLITE_RUNNER_OPS_LOCAL_PORT_BASE=3100
BOXLITE_RUNNER_OPS_BACKUP_BUCKET=boxlite
BOXLITE_RUNNER_OPS_BACKUP_ENDPOINT=http://127.0.0.1:29000
BOXLITE_RUNNER_OPS_BACKUP_REGION=us-east-1
BOXLITE_RUNNER_OPS_BACKUP_ACCESS_KEY=minioadmin
BOXLITE_RUNNER_OPS_BACKUP_SECRET_KEY=minioadmin
BOXLITE_RUNNER_OPS_API_URL=http://localhost:3009/api
# DISABLE_CRON_JOBS=false (already; crons needed for migration)
```

- [ ] **Step 3: Start API** — `( set -a && . ./.env && set +a && node dist/apps/api/main.js > .logs/api-3009.log 2>&1 & )`; wait health 200.

- [ ] **Step 4: add via wrapper (×2)** — `POST /api/admin/runner-ops/add-shared {name}` → poll job SUCCESS → runner READY. Repeat for a 2nd. Verify 2 new runners in `/shared`, each with a `~/.boxlite-runner-ops/<id>/meta.json`.

- [ ] **Step 5: create box** — cordon all but runner-A (or rely on seed), `POST /api/sandbox {target:us, snapshot:'ubuntu:22.04', name}` (seed snapshot_runner for runner-A if "No available runners"). Poll started on runner-A.

- [ ] **Step 6: scale-down via wrapper** — uncordon runner-B, `POST /api/admin/runner-ops/:A/scale-down {}` (no skipTerminate) → poll job SUCCESS. Verify: box migrated to runner-B (runnerId=B, started, sandbox.id preserved); runner-A row deleted; runner-A process gone (`kill -0` fails); `~/.boxlite-runner-ops/<A>/` removed by terminateRunner.

- [ ] **Step 7: Cleanup** — destroy box, terminate/clean runner-B, stop API, remove homes, delete MinIO archives.

- [ ] **Step 8: Commit any doc/runbook updates** — update `docs/runner-scaling/runner-ops-api-runbook.md` with the `BOXLITE_RUNNER_OPS_PROVIDER=local` setup + the add-via-wrapper flow.

---

## Self-Review Notes
- **Spec coverage:** §4 interface→T1; §5 AwsProvider+#2→T2; §6 LocalProvider→T3; §7 wiring→T4,T7,T8; §8 dryRun #3→T6; §9 config→T7; §10 files→all; §11 testing→T2/3/4/6 unit + T10 E2E. ✓
- **Type consistency:** `IInfraProvider.provisionRunner(spec)/terminateRunner(runnerId)/describeRunner(runnerId)` used identically in T2/T3/T5/T6/T7. `RunnerHostSpec` fields match the provisionRunner call in T5. `skipTerminate` defined in T6 (types) + consumed T6/T9. ✓
- **Placeholders:** test steps T3/T5/T6 reference existing test files for mock patterns rather than repeating full mock wiring — acceptable (the engineer has the existing tests); the provider implementations + refactor diffs have complete code. ✓

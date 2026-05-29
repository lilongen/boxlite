/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, ConflictException } from '@nestjs/common'
import { ulid } from 'ulid'
import { addSharedRunner } from '../../../../infra/lib/add-shared-runner-lib.js'
import { scaleDownRunner } from '../../../../infra/lib/scale-down-runner-lib.js'
import type {
  AddSharedRunnerOpts,
  AddSharedRunnerResult,
  ScaleDownOpts,
  ScaleDownResult,
  ProgressEvent,
} from '../../../../infra/lib/runner-ops-types.js'
import { createInfraProvider } from '../../../../infra/lib/infra-provider/factory.js'
import type {
  IInfraProvider,
  InfraProviderConfig,
} from '../../../../infra/lib/infra-provider/types.js'
import { TypedConfigService } from '../../config/typed-config.service'
import { RunnerOpsJobStore } from './runner-ops-job-store'

const ADD_LOCK_TTL = 1_800
const SCALE_LOCK_TTL = 3_600
// Background heartbeat cadence: renews the platform lock and observes a cancel
// request independently of the generator's yield cadence, so a long internal
// stage (readiness poll, drain/backup/archive waits) can't outlive the lock or
// ignore a cancel. Must be well under the lock TTLs above.
const HEARTBEAT_INTERVAL_MS = 10_000

// Any result/data key whose name looks like a live credential is masked before
// it is persisted to the 24h Redis job record / returned by GET /jobs/:id —
// matched at ANY depth (e.g. peers[].apiKey, sourceApiKey). The lib already
// emits a masked breadcrumb in the log lines, which is all the API path needs.
function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase()
  return k.includes('apikey') || k.includes('token') || k.includes('secret') || k.includes('password')
}

function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/** Deep-redact a value before it is persisted to the shared job store: recurse
 *  objects/arrays and mask any value sitting under a sensitive key at any depth.
 *  `keyHint` masks a top-level scalar emitted directly under a sensitive key
 *  (the `data` event case). Cycle-safe via a seen-set. */
function deepRedact(value: unknown, keyHint?: string, seen: WeakSet<object> = new WeakSet()): unknown {
  if (keyHint && isSensitiveKey(keyHint)) return maskSecret(value)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value as object)) return value
  seen.add(value as object)
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, undefined, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? maskSecret(v) : deepRedact(v, undefined, seen)
  }
  return out
}

@Injectable()
export class RunnerOpsService {
  private readonly logger = new Logger(RunnerOpsService.name)
  private readonly provider: IInfraProvider

  constructor(
    private readonly store: RunnerOpsJobStore,
    private readonly configService: TypedConfigService,
  ) {
    this.provider = createInfraProvider(this.buildProviderConfig())
    this.logger.log(`runner-ops provider: ${this.configService.get('runnerOps.provider') ?? 'aws'}`)
  }

  /** Reads `runnerOps.*` config into the discriminated InfraProviderConfig. */
  private buildProviderConfig(): InfraProviderConfig {
    const str = (k: string) => this.configService.get(k as never) as string | undefined
    const num = (k: string) => this.configService.get(k as never) as number | undefined
    const provider = str('runnerOps.provider') ?? 'aws'

    if (provider === 'local') {
      const runnerBin = str('runnerOps.localRunnerBin')
      if (!runnerBin) {
        throw new Error(
          'runnerOps.provider=local requires BOXLITE_RUNNER_OPS_LOCAL_RUNNER_BIN (path to boxlite-runner binary)',
        )
      }
      return {
        kind: 'local',
        runnerBin,
        dyld: str('runnerOps.localDyld'),
        homeRoot: str('runnerOps.localHomeRoot') ?? '~/.blr',
        portBase: num('runnerOps.localPortBase') ?? 3100,
        insecureRegistries: str('runnerOps.localInsecureRegistries') ?? '127.0.0.1:25000',
        terminateGraceSec: num('runnerOps.localTerminateGraceSec') ?? 15,
        apiUrl: this.configService.getOrThrow('runnerOps.apiUrl') as string,
        backupBucket: str('runnerOps.backupBucket'),
        backupEndpoint: str('runnerOps.backupEndpoint'),
        backupRegion: str('runnerOps.backupRegion') ?? 'us-east-1',
        backupAccessKey: str('runnerOps.backupAccessKey'),
        backupSecretKey: str('runnerOps.backupSecretKey'),
      }
    }

    return {
      kind: 'aws',
      awsRegion: this.configService.getOrThrow('runnerOps.awsRegion') as string,
      subnetId: str('runnerOps.subnetId'),
      instanceProfileName: str('runnerOps.instanceProfileName'),
      registryUrl: str('runnerOps.registryUrl'),
      cargoTomlPath: str('runnerOps.cargoTomlPath'),
      // Per-environment backups bucket: BOXLITE_RUNNER_OPS_BACKUP_BUCKET. Resolved
      // once here at provider construction; the runner gets BOXLITE_BACKUPS_BUCKET
      // set via user-data — never threaded per add-shared call.
      backupsBucket: str('runnerOps.backupBucket'),
    }
  }

  async startAddSharedRunner(input: {
    name?: string
    regionId?: string
    instanceType?: string
    diskGb?: number
    timeoutSec?: number
  }): Promise<{ id: string }> {
    const id = ulid()
    const acquired = await this.store.tryAcquireLock('add-shared', id, ADD_LOCK_TTL)
    if (!acquired) {
      const err = new ConflictException('another add-shared job is running') as any
      err.status = 409
      throw err
    }
    await this.store.create({ id, kind: 'add-shared', startedAt: new Date().toISOString() })

    const opts: AddSharedRunnerOpts = {
      apiUrl: this.configService.getOrThrow('runnerOps.apiUrl') as string,
      adminToken: this.configService.getOrThrow('runnerOps.adminToken') as string,
      awsRegion: this.configService.getOrThrow('runnerOps.awsRegion') as string,
      name: input.name,
      regionId: input.regionId,
      instanceType: input.instanceType,
      diskGb: input.diskGb,
      registryUrl: (this.configService.get('runnerOps.registryUrl') as string | undefined) ?? undefined,
      subnetId: (this.configService.get('runnerOps.subnetId') as string | undefined) ?? undefined,
      instanceProfileName:
        (this.configService.get('runnerOps.instanceProfileName') as string | undefined) ?? undefined,
      timeoutSec: input.timeoutSec,
      noWait: false,
    }

    void this.pumpAdd(id, opts)
    return { id }
  }

  async startScaleDownRunner(
    runnerId: string,
    input: {
      restartStopped?: boolean
      skipTerminate?: boolean
      skipEc2Terminate?: boolean
      dryRun?: boolean
      maxWaitBackupSec?: number
      maxWaitStopSec?: number
      maxWaitArchiveSec?: number
      maxWaitStartSec?: number
    },
  ): Promise<{ id: string }> {
    const id = ulid()
    const acquired = await this.store.tryAcquireLock('scale-down', id, SCALE_LOCK_TTL)
    if (!acquired) {
      const err = new ConflictException('another scale-down job is running') as any
      err.status = 409
      throw err
    }
    await this.store.create({ id, kind: 'scale-down', startedAt: new Date().toISOString() })

    const opts: ScaleDownOpts = {
      apiUrl: this.configService.getOrThrow('runnerOps.apiUrl') as string,
      adminToken: this.configService.getOrThrow('runnerOps.adminToken') as string,
      awsRegion: this.configService.getOrThrow('runnerOps.awsRegion') as string,
      runnerId,
      restartStopped: input.restartStopped,
      skipTerminate: input.skipTerminate,
      skipEc2Terminate: input.skipEc2Terminate,
      dryRun: input.dryRun,
      maxWaitBackupSec: input.maxWaitBackupSec,
      maxWaitStopSec: input.maxWaitStopSec,
      maxWaitArchiveSec: input.maxWaitArchiveSec,
      maxWaitStartSec: input.maxWaitStartSec,
    }

    void this.pumpScaleDown(id, opts)
    return { id }
  }

  async getJob(jobId: string) {
    return this.store.get(jobId)
  }

  async requestCancel(jobId: string) {
    await this.store.requestCancel(jobId)
    return this.store.get(jobId)
  }

  // Injection seam for unit tests
  protected runAddSharedRunner(
    opts: AddSharedRunnerOpts,
  ): AsyncGenerator<ProgressEvent, AddSharedRunnerResult, void> {
    return addSharedRunner(opts, this.provider)
  }

  protected runScaleDownRunner(
    opts: ScaleDownOpts,
  ): AsyncGenerator<ProgressEvent, ScaleDownResult, void> {
    return scaleDownRunner(opts, this.provider)
  }

  private async pumpAdd(id: string, opts: AddSharedRunnerOpts): Promise<void> {
    let currentStage = 0
    // Wire a real cancel + lock heartbeat to the generator. The lib calls
    // checkAborted(opts.signal) at every stage, so aborting here unwinds it.
    const controller = new AbortController()
    opts.signal = controller.signal
    const stopHeartbeat = this.startHeartbeat('add-shared', id, ADD_LOCK_TTL, controller)
    try {
      const gen = this.runAddSharedRunner(opts)
      while (true) {
        await this.heartbeatAndMaybeCancel('add-shared', id, ADD_LOCK_TTL, controller)
        const next = await gen.next()
        if (next.done) {
          await this.store.complete(id, deepRedact(next.value))
          break
        }
        await this.applyEvent(id, next.value as ProgressEvent, (s) => {
          currentStage = s
        })
      }
    } catch (e) {
      if (controller.signal.aborted) {
        this.logger.log(`add-shared job ${id} cancelled at stage ${currentStage}`)
        await this.store.markCancelled(id, currentStage || undefined)
      } else {
        const msg = (e as Error)?.message ?? String(e)
        this.logger.error(`add-shared job ${id} failed: ${msg}`)
        await this.store.fail(id, msg, currentStage || undefined)
      }
    } finally {
      stopHeartbeat()
      await this.store.releaseLock('add-shared', id)
    }
  }

  private async pumpScaleDown(id: string, opts: ScaleDownOpts): Promise<void> {
    let currentStage = 0
    const controller = new AbortController()
    opts.signal = controller.signal
    const stopHeartbeat = this.startHeartbeat('scale-down', id, SCALE_LOCK_TTL, controller)
    try {
      const gen = this.runScaleDownRunner(opts)
      while (true) {
        await this.heartbeatAndMaybeCancel('scale-down', id, SCALE_LOCK_TTL, controller)
        const next = await gen.next()
        if (next.done) {
          await this.store.complete(id, deepRedact(next.value))
          break
        }
        await this.applyEvent(id, next.value as ProgressEvent, (s) => {
          currentStage = s
        })
      }
    } catch (e) {
      if (controller.signal.aborted) {
        this.logger.log(`scale-down job ${id} cancelled at stage ${currentStage}`)
        await this.store.markCancelled(id, currentStage || undefined)
      } else {
        const msg = (e as Error)?.message ?? String(e)
        this.logger.error(`scale-down job ${id} failed: ${msg}`)
        await this.store.fail(id, msg, currentStage || undefined)
      }
    } finally {
      stopHeartbeat()
      await this.store.releaseLock('scale-down', id)
    }
  }

  /** Start a background lock-renew + cancel-observe timer that runs independently
   *  of the generator's yield cadence — so a long internal stage (readiness poll,
   *  drain/backup/archive waits) still renews the lock and honors a cancel.
   *  Returns a stop fn for the pump's finally. */
  private startHeartbeat(
    kind: 'add-shared' | 'scale-down',
    id: string,
    ttlSec: number,
    controller: AbortController,
  ): () => void {
    const timer = setInterval(() => {
      // best-effort: heartbeatAndMaybeCancel swallows its own errors.
      void this.heartbeatAndMaybeCancel(kind, id, ttlSec, controller)
    }, HEARTBEAT_INTERVAL_MS)
    // Don't keep the event loop alive solely for the heartbeat.
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }

  /** Renew the platform lock and abort the job if a cancel was requested.
   *  BEST-EFFORT: a transient store error must never fail or cancel a healthy
   *  in-flight job, so all errors are logged and swallowed (a sustained outage
   *  simply lets the lock lapse at its TTL, the intended dead-job behavior). */
  private async heartbeatAndMaybeCancel(
    kind: 'add-shared' | 'scale-down',
    id: string,
    ttlSec: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.store.renewLock(kind, id, ttlSec)
      if (!controller.signal.aborted && (await this.store.isCancelRequested(id))) {
        controller.abort()
      }
    } catch (e) {
      this.logger.warn(`runner-ops heartbeat ${kind} ${id}: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  private async applyEvent(jobId: string, ev: ProgressEvent, setStage: (s: number) => void): Promise<void> {
    if (ev.type === 'stage') {
      setStage(ev.stage)
      await this.store.setStage(jobId, ev.stage, ev.total, ev.label)
    } else if (ev.type === 'log') {
      await this.store.appendLine(jobId, ev.line)
    } else if (ev.type === 'warning') {
      await this.store.appendLine(jobId, `WARN: ${ev.line}`)
    } else if (ev.type === 'data') {
      await this.store.setResultField(jobId, ev.key, deepRedact(ev.value, ev.key))
    }
  }
}

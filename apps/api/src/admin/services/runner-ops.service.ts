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

// Result keys whose values are live credentials. The job record is persisted to
// Redis for 24h and returned verbatim by GET /jobs/:id, so the full value must
// never land there. The lib already emits a masked breadcrumb in the log lines
// (e.g. "apiKey ab12…ef90"), which is all an operator needs from the API path.
const SENSITIVE_RESULT_KEYS = new Set(['apiKey'])

function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/** Mask sensitive fields of a (possibly nested-free) result object before it is
 *  persisted to the shared job store. Non-objects pass through unchanged. */
function redactResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) }
  for (const k of Object.keys(out)) {
    if (SENSITIVE_RESULT_KEYS.has(k)) out[k] = maskSecret(out[k])
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
    try {
      const gen = this.runAddSharedRunner(opts)
      while (true) {
        await this.heartbeatAndMaybeCancel('add-shared', id, ADD_LOCK_TTL, controller)
        const next = await gen.next()
        if (next.done) {
          await this.store.complete(id, redactResult(next.value))
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
      await this.store.releaseLock('add-shared', id)
    }
  }

  private async pumpScaleDown(id: string, opts: ScaleDownOpts): Promise<void> {
    let currentStage = 0
    const controller = new AbortController()
    opts.signal = controller.signal
    try {
      const gen = this.runScaleDownRunner(opts)
      while (true) {
        await this.heartbeatAndMaybeCancel('scale-down', id, SCALE_LOCK_TTL, controller)
        const next = await gen.next()
        if (next.done) {
          await this.store.complete(id, redactResult(next.value))
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
      await this.store.releaseLock('scale-down', id)
    }
  }

  /** Per-step housekeeping run before each generator advance: (1) renew the
   *  platform lock so a long-but-live op never expires it, and (2) abort the
   *  generator if an operator has requested cancel. Aborting makes the lib's
   *  next checkAborted(signal) throw, unwinding into the cancel branch. */
  private async heartbeatAndMaybeCancel(
    kind: 'add-shared' | 'scale-down',
    id: string,
    ttlSec: number,
    controller: AbortController,
  ): Promise<void> {
    await this.store.renewLock(kind, id, ttlSec)
    if (!controller.signal.aborted && (await this.store.isCancelRequested(id))) {
      controller.abort()
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
      const value = SENSITIVE_RESULT_KEYS.has(ev.key) ? maskSecret(ev.value) : ev.value
      await this.store.setResultField(jobId, ev.key, value)
    }
  }
}

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
        homeRoot: str('runnerOps.localHomeRoot') ?? '~/.boxlite-runner-ops',
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
    }
  }

  async startAddSharedRunner(input: {
    name?: string
    regionId?: string
    instanceType?: string
    diskGb?: number
    withBackupSidecar?: boolean
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
      withBackupSidecar: input.withBackupSidecar,
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
    try {
      const gen = this.runAddSharedRunner(opts)
      while (true) {
        const next = await gen.next()
        if (next.done) {
          await this.store.complete(id, next.value)
          break
        }
        await this.applyEvent(id, next.value as ProgressEvent, (s) => {
          currentStage = s
        })
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      this.logger.error(`add-shared job ${id} failed: ${msg}`)
      await this.store.fail(id, msg, currentStage || undefined)
    } finally {
      await this.store.releaseLock('add-shared', id)
    }
  }

  private async pumpScaleDown(id: string, opts: ScaleDownOpts): Promise<void> {
    let currentStage = 0
    try {
      const gen = this.runScaleDownRunner(opts)
      while (true) {
        const next = await gen.next()
        if (next.done) {
          await this.store.complete(id, next.value)
          break
        }
        await this.applyEvent(id, next.value as ProgressEvent, (s) => {
          currentStage = s
        })
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      this.logger.error(`scale-down job ${id} failed: ${msg}`)
      await this.store.fail(id, msg, currentStage || undefined)
    } finally {
      await this.store.releaseLock('scale-down', id)
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
      await this.store.setResultField(jobId, ev.key, ev.value)
    }
  }
}

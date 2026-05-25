/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, ConflictException } from '@nestjs/common'
import { ulid } from 'ulid'
import { addSharedRunner } from '../../../../infra/lib/add-shared-runner-lib'
import { scaleDownRunner } from '../../../../infra/lib/scale-down-runner-lib'
import type { AddSharedRunnerOpts, ScaleDownOpts, ProgressEvent } from '../../../../infra/lib/runner-ops-types'
import { TypedConfigService } from '../../config/typed-config.service'
import { RunnerOpsJobStore } from './runner-ops-job-store'

const ADD_LOCK_TTL = 1_800
const SCALE_LOCK_TTL = 3_600

@Injectable()
export class RunnerOpsService {
  private readonly logger = new Logger(RunnerOpsService.name)

  constructor(
    private readonly store: RunnerOpsJobStore,
    private readonly configService: TypedConfigService,
  ) {}

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
  protected runAddSharedRunner(opts: AddSharedRunnerOpts) {
    return addSharedRunner(opts)
  }

  protected runScaleDownRunner(opts: ScaleDownOpts) {
    return scaleDownRunner(opts)
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
        await this.applyEvent(id, next.value, (s) => {
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
        await this.applyEvent(id, next.value, (s) => {
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

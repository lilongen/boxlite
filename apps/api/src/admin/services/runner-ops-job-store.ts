/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'

const KEY_PREFIX = 'runner-ops:job:'
const TTL_SECONDS = 86_400 // 24h
const MAX_LINES = 1_000

export type JobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'STALE'

export type JobKind = 'add-shared' | 'scale-down'

export interface JobRecord {
  id: string
  kind: JobKind
  status: JobStatus
  startedAt: string
  finishedAt?: string
  currentStage?: number
  totalStages?: number
  lines: string[]
  exitCode?: number
  result?: unknown
  error?: { message: string; stage?: number }
}

@Injectable()
export class RunnerOpsJobStore {
  private readonly logger = new Logger(RunnerOpsJobStore.name)

  constructor(@InjectRedis() private readonly redis: Redis) {}

  private key(id: string): string {
    return `${KEY_PREFIX}${id}`
  }

  async create(
    init: Pick<JobRecord, 'id' | 'kind' | 'startedAt'>,
  ): Promise<void> {
    const rec: JobRecord = { ...init, status: 'RUNNING', lines: [] }
    await this.redis.set(
      this.key(init.id),
      JSON.stringify(rec),
      'EX',
      TTL_SECONDS,
    )
  }

  async get(id: string): Promise<JobRecord | null> {
    const raw = await this.redis.get(this.key(id))
    if (!raw) return null
    return JSON.parse(raw) as JobRecord
  }

  private async update(
    id: string,
    fn: (rec: JobRecord) => void,
  ): Promise<void> {
    const rec = await this.get(id)
    if (!rec) {
      this.logger.warn(`update on missing job ${id}`)
      return
    }
    fn(rec)
    await this.redis.set(
      this.key(id),
      JSON.stringify(rec),
      'EX',
      TTL_SECONDS,
    )
  }

  async setStage(
    id: string,
    stage: number,
    total: number,
    label: string,
  ): Promise<void> {
    await this.update(id, (rec) => {
      rec.currentStage = stage
      rec.totalStages = total
      rec.lines.push(`[${stage}/${total}] ${label}`)
      if (rec.lines.length > MAX_LINES) {
        rec.lines = rec.lines.slice(-MAX_LINES)
      }
    })
  }

  async appendLine(id: string, line: string): Promise<void> {
    await this.update(id, (rec) => {
      rec.lines.push(line)
      if (rec.lines.length > MAX_LINES) {
        rec.lines = rec.lines.slice(-MAX_LINES)
      }
    })
  }

  async setResultField(id: string, key: string, value: unknown): Promise<void> {
    await this.update(id, (rec) => {
      if (!rec.result || typeof rec.result !== 'object') {
        rec.result = {}
      }
      ;(rec.result as Record<string, unknown>)[key] = value
    })
  }

  async complete(id: string, result: unknown): Promise<void> {
    await this.update(id, (rec) => {
      rec.status = 'SUCCESS'
      rec.finishedAt = new Date().toISOString()
      rec.exitCode = 0
      if (result && typeof result === 'object') {
        rec.result = {
          ...(rec.result as Record<string, unknown> | undefined),
          ...(result as Record<string, unknown>),
        }
      } else {
        rec.result = result
      }
    })
  }

  async fail(id: string, message: string, stage?: number): Promise<void> {
    await this.update(id, (rec) => {
      rec.status = 'FAILED'
      rec.finishedAt = new Date().toISOString()
      rec.error = { message, stage }
    })
  }

  async requestCancel(id: string): Promise<void> {
    await this.update(id, (rec) => {
      if (rec.status === 'RUNNING') rec.status = 'CANCEL_REQUESTED'
    })
  }

  async tryAcquireLock(
    kind: JobKind,
    jobId: string,
    ttlSec: number,
  ): Promise<boolean> {
    const lockKey = `runner-ops:lock:${kind}`
    const res = await this.redis.set(lockKey, jobId, 'EX', ttlSec, 'NX')
    return res === 'OK'
  }

  async releaseLock(kind: JobKind, jobId: string): Promise<void> {
    const lockKey = `runner-ops:lock:${kind}`
    const current = await this.redis.get(lockKey)
    if (current === jobId) await this.redis.del(lockKey)
  }
}

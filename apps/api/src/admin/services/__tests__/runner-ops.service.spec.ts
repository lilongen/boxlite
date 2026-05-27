/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test } from '@nestjs/testing'
import { RunnerOpsService } from '../runner-ops.service'
import { RunnerOpsJobStore } from '../runner-ops-job-store'
import { TypedConfigService } from '../../../config/typed-config.service'

class FakeStore {
  jobs = new Map<string, any>()
  lock: string | null = null
  async tryAcquireLock(_kind: any, id: string) {
    if (this.lock) return false
    this.lock = id
    return true
  }
  async releaseLock() {
    this.lock = null
  }
  async create(init: any) {
    this.jobs.set(init.id, { ...init, status: 'RUNNING', lines: [] })
  }
  async setStage(id: string, s: number, t: number, l: string) {
    this.jobs.get(id)?.lines.push(`[${s}/${t}] ${l}`)
  }
  async appendLine(id: string, l: string) {
    this.jobs.get(id)?.lines.push(l)
  }
  async setResultField(id: string, k: string, v: unknown) {
    const r = this.jobs.get(id)
    if (!r) return
    r.result = { ...(r.result ?? {}), [k]: v }
  }
  async complete(id: string, r: unknown) {
    const j = this.jobs.get(id)!
    j.status = 'SUCCESS'
    j.result = { ...(j.result ?? {}), ...(r as any) }
  }
  async fail(id: string, m: string, s?: number) {
    const j = this.jobs.get(id)!
    j.status = 'FAILED'
    j.error = { message: m, stage: s }
  }
  async requestCancel(id: string) {
    const j = this.jobs.get(id)
    if (j?.status === 'RUNNING') j.status = 'CANCEL_REQUESTED'
  }
  async get(id: string) {
    return this.jobs.get(id) ?? null
  }
}

const fakeConfig = {
  get: (k: string) =>
    ({
      'runnerOps.apiUrl': 'http://api',
      'runnerOps.adminToken': 'tok',
      'runnerOps.awsRegion': 'us-1',
      'runnerOps.subnetId': 'subnet',
      'runnerOps.instanceProfileName': 'profile',
      'runnerOps.registryUrl': 'http://reg',
    } as Record<string, string>)[k],
  getOrThrow: (k: string) => fakeConfig.get(k),
}

describe('RunnerOpsService', () => {
  async function makeService(libOverrides?: Partial<RunnerOpsService>) {
    const store = new FakeStore()
    const mod = await Test.createTestingModule({
      providers: [
        RunnerOpsService,
        { provide: RunnerOpsJobStore, useValue: store },
        { provide: TypedConfigService, useValue: fakeConfig },
      ],
    }).compile()
    const service = mod.get(RunnerOpsService)
    Object.assign(service, libOverrides ?? {})
    return { service, store }
  }

  it('rejects a second add-shared job while one is running', async () => {
    const { service, store } = await makeService({
      runAddSharedRunner: () =>
        (async function* () {
          await new Promise((r) => setTimeout(r, 20))
          return { runnerId: 'r1' } as any
        })(),
    } as any)
    const a = await service.startAddSharedRunner({ name: 'a' })
    await expect(service.startAddSharedRunner({ name: 'b' })).rejects.toMatchObject({ status: 409 })
    await new Promise((r) => setTimeout(r, 80))
    expect(store.jobs.get(a.id)?.status).toBe('SUCCESS')
  })

  it('records FAILED on lib throw', async () => {
    const { service, store } = await makeService({
      runAddSharedRunner: () =>
        (async function* () {
          throw new Error('aws-boom')
        })(),
    } as any)
    const j = await service.startAddSharedRunner({})
    await new Promise((r) => setTimeout(r, 50))
    expect(store.jobs.get(j.id)?.status).toBe('FAILED')
    expect(store.jobs.get(j.id)?.error?.message).toMatch(/aws-boom/)
  })

  it('persists stage and log events into the job', async () => {
    const { service, store } = await makeService({
      runAddSharedRunner: () =>
        (async function* () {
          yield { type: 'stage', stage: 1, total: 2, label: 'first' }
          yield { type: 'log', line: 'doing work' }
          yield { type: 'data', key: 'apiKey', value: 'secret-key' }
          yield { type: 'stage', stage: 2, total: 2, label: 'second' }
          return { runnerId: 'r1' } as any
        })(),
    } as any)
    const j = await service.startAddSharedRunner({})
    await new Promise((r) => setTimeout(r, 80))
    const rec = store.jobs.get(j.id)
    expect(rec.lines).toEqual(['[1/2] first', 'doing work', '[2/2] second'])
    expect(rec.result).toMatchObject({ apiKey: 'secret-key', runnerId: 'r1' })
    expect(rec.status).toBe('SUCCESS')
  })
})

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ExecutionContext } from '@nestjs/common'
import * as request from 'supertest'
import { CombinedAuthGuard } from '../../../auth/combined-auth.guard'
import { RunnerOpsController } from '../runner-ops.controller'
import { RunnerOpsService } from '../../services/runner-ops.service'
import { RunnerService } from '../../../sandbox/services/runner.service'
import { SystemActionGuard } from '../../../auth/system-action.guard'

describe('RunnerOpsController', () => {
  let app: INestApplication
  const service = {
    startAddSharedRunner: jest.fn(),
    startScaleDownRunner: jest.fn(),
    getJob: jest.fn(),
    requestCancel: jest.fn(),
  }
  const runnerService = { findAllFull: jest.fn() }

  beforeAll(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      controllers: [RunnerOpsController],
      providers: [
        { provide: RunnerOpsService, useValue: service },
        { provide: RunnerService, useValue: runnerService },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({ canActivate: (_: ExecutionContext) => true })
      .overrideGuard(SystemActionGuard)
      .useValue({ canActivate: (_: ExecutionContext) => true })
      .compile()
    app = mod.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /admin/runner-ops/shared returns runners', async () => {
    runnerService.findAllFull.mockResolvedValueOnce([
      {
        id: 'r-1',
        name: 'a',
        region: 'us',
        state: 'ready',
        availabilityScore: 80,
        cpu: 8,
        memoryGiB: 16,
        diskGiB: 100,
        currentStartedSandboxes: 1,
        currentCpuUsagePercentage: 10,
        currentMemoryUsagePercentage: 20,
        currentDiskUsagePercentage: 30,
        unschedulable: false,
        draining: false,
        lastChecked: new Date('2026-05-25T00:00:00Z'),
      },
    ])
    const res = await request(app.getHttpServer()).get('/admin/runner-ops/shared').expect(200)
    expect(res.body.runners).toHaveLength(1)
    expect(res.body.runners[0].id).toBe('r-1')
  })

  it('POST /admin/runner-ops/add-shared returns 202', async () => {
    service.startAddSharedRunner.mockResolvedValueOnce({ id: 'j-1' })
    const res = await request(app.getHttpServer())
      .post('/admin/runner-ops/add-shared')
      .send({ name: 'rx' })
      .expect(202)
    expect(res.body.id).toBe('j-1')
  })

  it('POST /admin/runner-ops/:id/scale-down returns 202', async () => {
    service.startScaleDownRunner.mockResolvedValueOnce({ id: 'j-2' })
    const res = await request(app.getHttpServer())
      .post('/admin/runner-ops/r-1/scale-down')
      .send({})
      .expect(202)
    expect(res.body.id).toBe('j-2')
  })

  it('GET /admin/runner-ops/jobs/:id returns 404 when missing', async () => {
    service.getJob.mockResolvedValueOnce(null)
    await request(app.getHttpServer()).get('/admin/runner-ops/jobs/none').expect(404)
  })

  it('POST /admin/runner-ops/jobs/:id/cancel returns updated job', async () => {
    service.requestCancel.mockResolvedValueOnce({
      id: 'j-1',
      status: 'CANCEL_REQUESTED',
      kind: 'add-shared',
      startedAt: 'x',
      lines: [],
    })
    const res = await request(app.getHttpServer())
      .post('/admin/runner-ops/jobs/j-1/cancel')
      .expect(200)
    expect(res.body.status).toBe('CANCEL_REQUESTED')
  })
})

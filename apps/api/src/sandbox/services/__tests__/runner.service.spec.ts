/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerService } from '../runner.service'
import { Runner } from '../../entities/runner.entity'
import { RegionType } from '../../../region/enums/region-type.enum'
import { RunnerFullDto } from '../../dto/runner-full.dto'

describe('RunnerService.findAllFull regionType filter', () => {
  let service: RunnerService
  let mockRunnerRepository: any
  let mockRegionService: any

  beforeEach(() => {
    mockRunnerRepository = {
      find: jest.fn(),
    }

    mockRegionService = {
      findByIds: jest.fn(),
    }

    service = {
      runnerRepository: mockRunnerRepository,
      regionService: mockRegionService,
      findAllFull: RunnerService.prototype.findAllFull,
    } as any
  })

  it('returns all runners when no filter is provided', async () => {
    // findAllFull maps createdAt/updatedAt via .toISOString(), so the fixtures
    // must carry those Dates (a bare {id,region} crashes the mapper).
    const runner1 = { id: 'r-1', region: 'region-1', createdAt: new Date(), updatedAt: new Date() } as Runner
    const runner2 = { id: 'r-2', region: 'region-2', createdAt: new Date(), updatedAt: new Date() } as Runner

    mockRunnerRepository.find.mockResolvedValue([runner1, runner2])
    mockRegionService.findByIds.mockResolvedValue([
      { id: 'region-1', regionType: RegionType.SHARED } as any,
      { id: 'region-2', regionType: RegionType.CUSTOM } as any,
    ])

    const result = await service.findAllFull()

    expect(result).toHaveLength(2)
    expect(mockRunnerRepository.find).toHaveBeenCalledWith()
  })

  it('filters runners by regionType when filter is provided', async () => {
    // findAllFull maps createdAt/updatedAt via .toISOString(), so the fixtures
    // must carry those Dates (a bare {id,region} crashes the mapper).
    const runner1 = { id: 'r-1', region: 'region-1', createdAt: new Date(), updatedAt: new Date() } as Runner
    const runner2 = { id: 'r-2', region: 'region-2', createdAt: new Date(), updatedAt: new Date() } as Runner

    mockRunnerRepository.find.mockResolvedValue([runner1, runner2])
    mockRegionService.findByIds.mockResolvedValue([
      { id: 'region-1', regionType: RegionType.SHARED } as any,
      { id: 'region-2', regionType: RegionType.CUSTOM } as any,
    ])

    const result = await service.findAllFull({ regionType: RegionType.SHARED })

    expect(result).toHaveLength(1)
    // The result should only contain the runner with SHARED region
    expect(mockRunnerRepository.find).toHaveBeenCalledWith()
  })

  it('returns empty array when filter excludes all runners', async () => {
    // findAllFull maps createdAt/updatedAt via .toISOString(), so the fixtures
    // must carry those Dates (a bare {id,region} crashes the mapper).
    const runner1 = { id: 'r-1', region: 'region-1', createdAt: new Date(), updatedAt: new Date() } as Runner
    const runner2 = { id: 'r-2', region: 'region-2', createdAt: new Date(), updatedAt: new Date() } as Runner

    mockRunnerRepository.find.mockResolvedValue([runner1, runner2])
    mockRegionService.findByIds.mockResolvedValue([
      { id: 'region-1', regionType: RegionType.SHARED } as any,
      { id: 'region-2', regionType: RegionType.SHARED } as any,
    ])

    const result = await service.findAllFull({ regionType: RegionType.CUSTOM })

    expect(result).toHaveLength(0)
  })
})

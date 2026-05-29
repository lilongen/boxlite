/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { RunnerService } from '../../sandbox/services/runner.service'
import { RegionType } from '../../region/enums/region-type.enum'
import { RunnerOpsService } from '../services/runner-ops.service'
import {
  AddSharedRunnerRequestDto,
  JobDto,
  ListSharedRunnersResponseDto,
  ScaleDownRequestDto,
  SharedRunnerSummaryDto,
} from '../dto/runner-ops.dto'

@ApiTags('admin-runner-ops')
@ApiBearerAuth()
@ApiOAuth2(['openid', 'profile', 'email'])
@Controller('admin/runner-ops')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
export class RunnerOpsController {
  private readonly logger = new Logger(RunnerOpsController.name)

  constructor(
    private readonly service: RunnerOpsService,
    private readonly runnerService: RunnerService,
  ) {}

  @Get('shared')
  @ApiOperation({ operationId: 'listSharedRunners', summary: 'List all SHARED runners' })
  @ApiResponse({ status: 200, type: ListSharedRunnersResponseDto })
  async listShared(): Promise<ListSharedRunnersResponseDto> {
    const all = await this.runnerService.findAllFull({ regionType: RegionType.SHARED })
    const runners: SharedRunnerSummaryDto[] = all.map((r: any) => ({
      id: r.id,
      name: r.name,
      regionId: r.region ?? r.regionId,
      state: r.state,
      availabilityScore: r.availabilityScore ?? 0,
      cpu: r.cpu,
      memoryGiB: r.memoryGiB,
      diskGiB: r.diskGiB,
      currentStartedSandboxes: r.currentStartedSandboxes ?? 0,
      currentCpuUsagePercentage: r.currentCpuUsagePercentage ?? 0,
      currentMemoryUsagePercentage: r.currentMemoryUsagePercentage ?? 0,
      currentDiskUsagePercentage: r.currentDiskUsagePercentage ?? 0,
      unschedulable: !!r.unschedulable,
      draining: !!r.draining,
      lastChecked: (r.lastChecked instanceof Date ? r.lastChecked.toISOString() : String(r.lastChecked ?? '')),
    }))
    return { runners }
  }

  @Post('add-shared')
  @HttpCode(202)
  @ApiOperation({ operationId: 'addSharedRunner', summary: 'Provision a new SHARED runner' })
  @ApiResponse({ status: 202, schema: { type: 'object', properties: { id: { type: 'string' } } } })
  async addShared(@Body() body: AddSharedRunnerRequestDto): Promise<{ id: string }> {
    return this.service.startAddSharedRunner(body)
  }

  @Post(':runnerId/scale-down')
  @HttpCode(202)
  @ApiOperation({ operationId: 'scaleDownRunner', summary: 'Drain and remove a SHARED runner' })
  @ApiResponse({ status: 202, schema: { type: 'object', properties: { id: { type: 'string' } } } })
  async scaleDown(
    // runner ids are UUID PKs; reject malformed ids at the boundary (400) rather
    // than passing them into the self-call URL.
    @Param('runnerId', ParseUUIDPipe) runnerId: string,
    @Body() body: ScaleDownRequestDto,
  ): Promise<{ id: string }> {
    return this.service.startScaleDownRunner(runnerId, body)
  }

  @Get('jobs/:jobId')
  @ApiOperation({ operationId: 'getRunnerOpsJob', summary: 'Get a runner-ops job by id' })
  @ApiResponse({ status: 200, type: JobDto })
  async getJob(@Param('jobId') jobId: string): Promise<JobDto> {
    const job = await this.service.getJob(jobId)
    if (!job) throw new NotFoundException(`job ${jobId} not found`)
    return job as unknown as JobDto
  }

  @Post('jobs/:jobId/cancel')
  @HttpCode(200)
  @ApiOperation({ operationId: 'cancelRunnerOpsJob', summary: 'Cooperatively cancel a runner-ops job' })
  @ApiResponse({ status: 200, type: JobDto })
  async cancelJob(@Param('jobId') jobId: string): Promise<JobDto> {
    const job = await this.service.requestCancel(jobId)
    if (!job) throw new NotFoundException(`job ${jobId} not found`)
    return job as unknown as JobDto
  }
}

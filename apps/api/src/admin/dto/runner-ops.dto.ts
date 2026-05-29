/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, IsBoolean, IsInt, Min, Max, Matches } from 'class-validator'
import { RunnerState } from '../../sandbox/enums/runner-state.enum'

@ApiSchema({ name: 'AddSharedRunnerRequest' })
export class AddSharedRunnerRequestDto {
  @ApiPropertyOptional({ description: 'Runner name; auto-generated if omitted' })
  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9_.-]+$/)
  name?: string

  @ApiPropertyOptional({ description: 'Region ID; default "us"' })
  @IsOptional() @IsString()
  regionId?: string

  @ApiPropertyOptional({ description: 'EC2 instance type; default c8i.2xlarge' })
  @IsOptional() @IsString()
  instanceType?: string

  @ApiPropertyOptional({ description: 'EBS root volume size in GB; default 100' })
  @IsOptional() @IsInt() @Min(30) @Max(2000)
  diskGb?: number

  @ApiPropertyOptional({ description: 'Readiness poll timeout seconds; default 600' })
  @IsOptional() @IsInt() @Min(30) @Max(3600)
  timeoutSec?: number
}

@ApiSchema({ name: 'ScaleDownRequest' })
export class ScaleDownRequestDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  restartStopped?: boolean

  @ApiPropertyOptional({ description: 'Debug: do not terminate the runner host after deleting runner row' })
  @IsOptional() @IsBoolean()
  skipTerminate?: boolean

  @ApiPropertyOptional({
    deprecated: true,
    description: 'Deprecated alias of skipTerminate (kept for back-compat)',
  })
  @IsOptional() @IsBoolean()
  skipEc2Terminate?: boolean

  @ApiPropertyOptional({ description: 'Run preflight only, no side effects' })
  @IsOptional() @IsBoolean()
  dryRun?: boolean

  @ApiPropertyOptional({ description: 'Backup stage timeout seconds' })
  @IsOptional() @IsInt() @Min(30) @Max(3600)
  maxWaitBackupSec?: number

  @ApiPropertyOptional({ description: 'Stop stage timeout seconds' })
  @IsOptional() @IsInt() @Min(30) @Max(3600)
  maxWaitStopSec?: number

  @ApiPropertyOptional({ description: 'Archive stage timeout seconds' })
  @IsOptional() @IsInt() @Min(30) @Max(3600)
  maxWaitArchiveSec?: number

  @ApiPropertyOptional({ description: 'Restart stage timeout seconds' })
  @IsOptional() @IsInt() @Min(30) @Max(3600)
  maxWaitStartSec?: number
}

export type JobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'STALE'

@ApiSchema({ name: 'JobError' })
export class JobErrorDto {
  @ApiProperty() message: string
  @ApiPropertyOptional() stage?: number
}

@ApiSchema({ name: 'Job' })
export class JobDto {
  @ApiProperty() id: string
  @ApiProperty({ enum: ['add-shared', 'scale-down'] }) kind: 'add-shared' | 'scale-down'
  @ApiProperty({ enum: ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'STALE'] })
  status: JobStatus
  @ApiProperty() startedAt: string
  @ApiPropertyOptional() finishedAt?: string
  @ApiPropertyOptional() currentStage?: number
  @ApiPropertyOptional() totalStages?: number
  @ApiProperty({ type: [String] }) lines: string[]
  @ApiPropertyOptional() exitCode?: number
  @ApiPropertyOptional({ type: Object }) result?: unknown
  @ApiPropertyOptional({ type: () => JobErrorDto }) error?: JobErrorDto
}

@ApiSchema({ name: 'SharedRunnerSummary' })
export class SharedRunnerSummaryDto {
  @ApiProperty() id: string
  @ApiProperty() name: string
  @ApiProperty() regionId: string
  @ApiProperty({ enum: RunnerState }) state: RunnerState
  @ApiProperty() availabilityScore: number
  @ApiProperty() cpu: number
  @ApiProperty() memoryGiB: number
  @ApiProperty() diskGiB: number
  @ApiProperty() currentStartedSandboxes: number
  @ApiProperty() currentCpuUsagePercentage: number
  @ApiProperty() currentMemoryUsagePercentage: number
  @ApiProperty() currentDiskUsagePercentage: number
  @ApiProperty() unschedulable: boolean
  @ApiProperty() draining: boolean
  @ApiProperty() lastChecked: string
}

@ApiSchema({ name: 'ListSharedRunnersResponse' })
export class ListSharedRunnersResponseDto {
  @ApiProperty({ type: [SharedRunnerSummaryDto] })
  runners: SharedRunnerSummaryDto[]
}

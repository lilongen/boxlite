/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AdminRunnerController } from './controllers/runner.controller'
import { AdminSandboxController } from './controllers/sandbox.controller'
import { RunnerOpsController } from './controllers/runner-ops.controller'
import { RunnerOpsService } from './services/runner-ops.service'
import { RunnerOpsJobStore } from './services/runner-ops-job-store'
import { SandboxModule } from '../sandbox/sandbox.module'
import { RegionModule } from '../region/region.module'
import { OrganizationModule } from '../organization/organization.module'

@Module({
  imports: [SandboxModule, RegionModule, OrganizationModule],
  controllers: [AdminRunnerController, AdminSandboxController, RunnerOpsController],
  providers: [RunnerOpsService, RunnerOpsJobStore],
})
export class AdminModule {}

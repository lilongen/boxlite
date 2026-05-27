// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
//
// Shared types between add-shared-runner-lib and scale-down-runner-lib,
// the CLI shells under apps/infra/scripts/, and the NestJS service that
// consumes the libs from apps/api.

export type ProgressEvent =
  | { type: 'stage'; stage: number; total: number; label: string }
  | { type: 'log'; line: string }
  | { type: 'data'; key: string; value: unknown }
  | { type: 'warning'; line: string }

export interface AddSharedRunnerOpts {
  apiUrl: string
  adminToken: string
  awsRegion: string
  name?: string
  apiKey?: string
  regionId?: string
  instanceType?: string
  diskGb?: number
  withBackupSidecar?: boolean
  registryUrl?: string
  subnetId?: string
  instanceProfileName?: string
  timeoutSec?: number
  noWait?: boolean
  signal?: AbortSignal
}

export interface AddSharedRunnerResult {
  runnerId: string
  runnerName: string
  apiKey: string
  ec2InstanceId: string
  privateIp?: string
  finalState: 'READY' | 'INITIALIZING' | 'TIMEOUT'
}

export interface ScaleDownOpts {
  apiUrl: string
  adminToken: string
  awsRegion: string
  runnerId: string
  restartStopped?: boolean
  /** @deprecated provider-agnostic alias is `skipTerminate`; kept for back-compat */
  skipEc2Terminate?: boolean
  /** Skip the IInfraProvider.terminateRunner step (leave the host running). */
  skipTerminate?: boolean
  dryRun?: boolean
  maxWaitBackupSec?: number
  maxWaitStopSec?: number
  maxWaitArchiveSec?: number
  maxWaitStartSec?: number
  signal?: AbortSignal
}

export interface ScaleDownResult {
  runnerId: string
  sandboxesMigrated: string[]
  sandboxesArchived: string[]
  ec2InstancesTerminated: string[]
  durationMs: number
}

export class OperationAbortedError extends Error {
  constructor(message = 'operation aborted by caller') {
    super(message)
    this.name = 'OperationAbortedError'
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export interface RunnerHostSpec {
  runnerId: string
  apiKey: string
  apiUrl: string
  regionId: string
  instanceType?: string
  diskGb?: number
  withBackupSidecar?: boolean
  /** S3 bucket for `.boxlite` backup archives; surfaces as the runner's
   * `BOXLITE_BACKUPS_BUCKET` env (only applied when withBackupSidecar=true). */
  backupsBucket?: string
}

export interface ProvisionResult {
  endpoint?: string
}

export interface DescribeResult {
  alive: boolean
}

export interface IInfraProvider {
  provisionRunner(spec: RunnerHostSpec): Promise<ProvisionResult>
  terminateRunner(runnerId: string): Promise<void>
  describeRunner(runnerId: string): Promise<DescribeResult>
}

export interface AwsProviderConfig {
  kind: 'aws'
  awsRegion: string
  subnetId?: string
  instanceProfileName?: string
  registryUrl?: string
  cargoTomlPath?: string
}

export interface LocalProviderConfig {
  kind: 'local'
  runnerBin: string
  dyld?: string
  homeRoot: string
  portBase: number
  insecureRegistries: string
  terminateGraceSec: number
  apiUrl: string
  backupBucket?: string
  backupEndpoint?: string
  backupRegion: string
  backupAccessKey?: string
  backupSecretKey?: string
}

export type InfraProviderConfig = AwsProviderConfig | LocalProviderConfig

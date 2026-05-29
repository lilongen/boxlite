// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export interface RunnerHostSpec {
  runnerId: string
  apiKey: string
  apiUrl: string
  regionId: string
  instanceType?: string
  diskGb?: number
}

export interface ProvisionResult {
  /** Reachable host endpoint (AWS: private IP; local: http://127.0.0.1:<port>). */
  endpoint?: string
  /** Provider-native host id, when there is one (AWS: the EC2 instance id i-…).
   *  Undefined for the local process provider. */
  instanceId?: string
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
  /** Per-environment S3 bucket for `.boxlite` backup archives; sets the runner's
   * `BOXLITE_BACKUPS_BUCKET` env at provision time. Resolved once at provider
   * construction (e.g. from `BOXLITE_BACKUPS_BUCKET` / `BOXLITE_RUNNER_OPS_BACKUP_BUCKET`,
   * or by convention `boxlite-volume-backups-${stage}`). */
  backupsBucket?: string
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

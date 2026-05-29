// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
//
// AwsInfraProvider — EC2 implementation of IInfraProvider. The launch / AMI /
// tag-terminate logic was moved here verbatim from add-shared-runner-lib.ts and
// scale-down-runner-lib.ts; behaviour is unchanged. The only fix is #2: the
// runner user-data builder now always receives a non-empty cargoTomlPath
// (previously the lib passed '' → readFileSync('') → ENOENT).

import {
  EC2Client,
  RunInstancesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2'
import { buildRunnerUserData } from '../runner-user-data.js'
import type {
  IInfraProvider,
  RunnerHostSpec,
  ProvisionResult,
  DescribeResult,
  AwsProviderConfig,
} from './types.js'

const UBUNTU_OWNER_ID = '099720109477'
const UBUNTU_NAME_PATTERN = 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'

export class AwsInfraProvider implements IInfraProvider {
  private readonly client: EC2Client

  constructor(private readonly cfg: AwsProviderConfig) {
    this.client = new EC2Client({ region: cfg.awsRegion })
  }

  // #2 fix: never an empty string. The caller (CLI/service) resolves the
  // repo-root Cargo.toml; fail fast with a clear message if it wasn't set.
  private cargoTomlPath(): string {
    if (!this.cfg.cargoTomlPath || this.cfg.cargoTomlPath.length === 0) {
      throw new Error(
        'AwsInfraProvider requires cargoTomlPath (set BOXLITE_RUNNER_OPS_CARGO_TOML to the repo-root Cargo.toml)',
      )
    }
    return this.cfg.cargoTomlPath
  }

  async provisionRunner(spec: RunnerHostSpec): Promise<ProvisionResult> {
    const userDataBase64 = buildRunnerUserData({
      apiUrl: spec.apiUrl,
      token: spec.apiKey,
      registryUrl: this.cfg.registryUrl ?? '',
      runnerPort: 3003,
      // Per-environment bucket (set on the provider config), not per-call.
      backupsBucket: this.cfg.backupsBucket,
      awsRegion: this.cfg.awsRegion,
      cargoTomlPath: this.cargoTomlPath(),
    })

    const imageId = await this.resolveUbuntuAmi()
    const tags: Record<string, string> = {
      Name: `boxlite-runner-${spec.runnerId.slice(0, 8)}`,
      RunnerId: spec.runnerId,
      BoxliteOwner: 'aws-infra-provider',
      BoxliteRegion: spec.regionId,
    }
    if (typeof process !== 'undefined' && process.env.BOXLITE_STAGE) {
      tags.BoxliteStack = process.env.BOXLITE_STAGE
    }

    const run = await this.client.send(
      new RunInstancesCommand({
        ImageId: imageId,
        InstanceType: (spec.instanceType ?? 'c8i.2xlarge') as _InstanceType,
        IamInstanceProfile: this.cfg.instanceProfileName ? { Name: this.cfg.instanceProfileName } : undefined,
        UserData: userDataBase64,
        CpuOptions: { NestedVirtualization: 'enabled' } as Record<string, unknown>,
        NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: this.cfg.subnetId, AssociatePublicIpAddress: true }],
        BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: spec.diskGb ?? 100 } }],
        TagSpecifications: [
          { ResourceType: 'instance', Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
        ],
        MinCount: 1,
        MaxCount: 1,
      }),
    )
    const instance = run.Instances?.[0]
    if (!instance?.InstanceId) throw new Error('RunInstances returned no instance.')

    let privateIp: string | null = instance.PrivateIpAddress ?? null
    for (let i = 0; i < 6; i++) {
      if (privateIp) break
      await new Promise((r) => setTimeout(r, 5000))
      const desc = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [instance.InstanceId] }))
      const inst = desc.Reservations?.[0]?.Instances?.[0]
      privateIp = inst?.PrivateIpAddress ?? privateIp
      if (inst?.State?.Name === 'running') break
    }
    return { endpoint: privateIp ?? undefined, instanceId: instance.InstanceId }
  }

  async terminateRunner(runnerId: string): Promise<void> {
    const ids = await this.findByRunnerId(runnerId)
    if (ids.length > 0) {
      await this.client.send(new TerminateInstancesCommand({ InstanceIds: ids }))
    }
  }

  async describeRunner(runnerId: string): Promise<DescribeResult> {
    return { alive: (await this.findByRunnerId(runnerId)).length > 0 }
  }

  private async findByRunnerId(runnerId: string): Promise<string[]> {
    const d = await this.client.send(
      new DescribeInstancesCommand({ Filters: [{ Name: 'tag:RunnerId', Values: [runnerId] }] }),
    )
    return (d.Reservations ?? []).flatMap((r) =>
      (r.Instances ?? [])
        .filter((i) => i.InstanceId && i.State?.Name !== 'terminated' && i.State?.Name !== 'shutting-down')
        .map((i) => i.InstanceId as string),
    )
  }

  private async resolveUbuntuAmi(): Promise<string> {
    const r = await this.client.send(
      new DescribeImagesCommand({
        Owners: [UBUNTU_OWNER_ID],
        Filters: [
          { Name: 'name', Values: [UBUNTU_NAME_PATTERN] },
          { Name: 'architecture', Values: ['x86_64'] },
        ],
      }),
    )
    const images = (r.Images ?? [])
      .filter((i) => i.ImageId && i.CreationDate)
      .sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''))
    if (!images[0]?.ImageId) throw new Error('No Ubuntu Noble 24.04 AMI found in region.')
    return images[0].ImageId
  }
}

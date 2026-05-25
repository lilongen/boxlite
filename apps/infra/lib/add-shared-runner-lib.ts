// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import * as crypto from 'crypto'
import {
  EC2Client,
  RunInstancesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2'
import type {
  AddSharedRunnerOpts,
  AddSharedRunnerResult,
  ProgressEvent,
} from './runner-ops-types'
import { OperationAbortedError } from './runner-ops-types'
import { buildRunnerUserData } from './runner-user-data'

// ─── Constants ───────────────────────────────────────────────────────────────

const UBUNTU_OWNER_ID = '099720109477'
const UBUNTU_NAME_PATTERN = 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'

export const RUNNER_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/

// ─── Types ──────────────────────────────────────────────────────────────────

interface ApiClientOpts {
  baseUrl: string
  token: string
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    path: string,
  ) {
    super(`API ${method} ${path} → ${status}: ${body.slice(0, 500)}`)
  }
}

interface CreateRunnerResponseDto {
  id: string
  name: string
  apiKey: string
  region: string
}

interface RunnerFullDto {
  id: string
  name: string
  state: 'initializing' | 'ready' | 'disabled' | 'decommissioned' | 'unresponsive'
  regionType?: 'shared' | 'dedicated' | 'custom'
}

interface Ec2LaunchInput {
  subnetId: string
  instanceProfileName: string
  instanceType: string
  rootDiskGB: number
  userDataBase64: string
  tags: Record<string, string>
}

interface Ec2LaunchResult {
  instanceId: string
  publicIp: string | null
  privateIp: string | null
  availabilityZone: string | null
  imageId: string
}

// ─── Helpers (internal to lib) ──────────────────────────────────────────────

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationAbortedError()
}

async function apiFetch<T>(
  opts: ApiClientOpts,
  method: 'GET' | 'POST' | 'DELETE',
  apiPath: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  checkAborted(signal)
  const url = `${opts.baseUrl.replace(/\/$/, '')}${apiPath}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new ApiError(res.status, text, method, apiPath)
  }
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Non-JSON response from ${method} ${apiPath}: ${text.slice(0, 200)}`)
  }
}

function generateRunnerApiKey(): string {
  return `dtn_${crypto.randomBytes(32).toString('hex')}`
}

function defaultName(): string {
  return `runner-shared-${Math.random().toString(36).slice(2, 8)}`
}

async function probeAdminAuth(api: ApiClientOpts, signal?: AbortSignal): Promise<void> {
  await apiFetch<unknown>(api, 'GET', `/api/admin/runners`, undefined, signal)
}

async function createSharedRunner(
  api: ApiClientOpts,
  input: { regionId: string; name: string; apiKey: string },
  signal?: AbortSignal,
): Promise<{ id: string; apiKey: string }> {
  const r = await apiFetch<CreateRunnerResponseDto>(
    api,
    'POST',
    `/api/admin/runners`,
    {
      name: input.name,
      regionId: input.regionId,
      apiKey: input.apiKey,
      apiVersion: '2',
    },
    signal,
  )
  if (!r.id) {
    throw new Error(`POST /api/admin/runners returned no id: ${JSON.stringify(r)}`)
  }
  if (r.apiKey && r.apiKey !== input.apiKey) {
    throw new Error(`Server returned a different apiKey than we sent (unexpected).`)
  }
  return { id: r.id, apiKey: input.apiKey }
}

async function pollUntilReady(
  api: ApiClientOpts,
  runnerId: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    checkAborted(signal)
    try {
      const r = await apiFetch<RunnerFullDto>(api, 'GET', `/api/admin/runners/${runnerId}`)
      if (r.state === 'ready') return true
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) {
        // transient — keep polling
      } else if (e.status === 404) {
        throw new Error(`Runner ${runnerId} disappeared from API while polling.`)
      } else {
        throw e
      }
    }
    await new Promise((rs) => setTimeout(rs, 5000))
  }
  return false
}

async function resolveUbuntuAmi(client: EC2Client): Promise<string> {
  const r = await client.send(
    new DescribeImagesCommand({
      Owners: [UBUNTU_OWNER_ID],
      Filters: [
        { Name: 'name', Values: [UBUNTU_NAME_PATTERN] },
        { Name: 'architecture', Values: ['x86_64'] },
      ],
    }),
  )
  const images = (r.Images ?? []).filter((i) => i.ImageId && i.CreationDate)
  images.sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''))
  if (images.length === 0 || !images[0].ImageId) {
    throw new Error(`No Ubuntu Noble 24.04 AMI found in region.`)
  }
  return images[0].ImageId
}

async function launchRunnerEc2(client: EC2Client, input: Ec2LaunchInput): Promise<Ec2LaunchResult> {
  const imageId = await resolveUbuntuAmi(client)
  const tagList = Object.entries(input.tags).map(([Key, Value]) => ({ Key, Value }))

  const cpuOptions: any = { NestedVirtualization: 'enabled' }

  const run = await client.send(
    new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: input.instanceType as _InstanceType,
      IamInstanceProfile: { Name: input.instanceProfileName },
      UserData: input.userDataBase64,
      CpuOptions: cpuOptions,
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: input.subnetId,
          AssociatePublicIpAddress: true,
        },
      ],
      BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: input.rootDiskGB } }],
      TagSpecifications: [{ ResourceType: 'instance', Tags: tagList }],
      MinCount: 1,
      MaxCount: 1,
    }),
  )

  const instance = run.Instances?.[0]
  if (!instance?.InstanceId) throw new Error('RunInstances returned no instance.')

  let publicIp: string | null = instance.PublicIpAddress ?? null
  let privateIp: string | null = instance.PrivateIpAddress ?? null
  let az: string | null = instance.Placement?.AvailabilityZone ?? null

  for (let i = 0; i < 6; i++) {
    if (publicIp && privateIp && az) break
    await new Promise((r) => setTimeout(r, 5000))
    const desc = await client.send(
      new DescribeInstancesCommand({ InstanceIds: [instance.InstanceId] }),
    )
    const inst = desc.Reservations?.[0]?.Instances?.[0]
    if (!inst) break
    publicIp = inst.PublicIpAddress ?? publicIp
    privateIp = inst.PrivateIpAddress ?? privateIp
    az = inst.Placement?.AvailabilityZone ?? az
    if (inst.State?.Name === 'running') break
  }

  return { instanceId: instance.InstanceId, publicIp, privateIp, availabilityZone: az, imageId }
}

// ─── Main generator ────────────────────────────────────────────────────────

export async function* addSharedRunner(
  opts: AddSharedRunnerOpts,
): AsyncGenerator<ProgressEvent, AddSharedRunnerResult, void> {
  checkAborted(opts.signal)

  // Defaults and validation
  const apiUrl = opts.apiUrl
  const adminToken = opts.adminToken
  const awsRegion = opts.awsRegion
  const regionId = opts.regionId ?? 'us'
  const runnerName = opts.name ?? defaultName()
  const runnerApiKey = generateRunnerApiKey()
  const instanceType = opts.instanceType ?? 'c8i.2xlarge'
  const diskGb = opts.diskGb ?? 100
  const registryUrl = opts.registryUrl ?? ''
  const subnetId = opts.subnetId ?? ''
  const instanceProfileName = opts.instanceProfileName ?? ''
  const timeoutSec = opts.timeoutSec ?? 300
  const noWait = opts.noWait ?? false
  const withBackupSidecar = opts.withBackupSidecar ?? false
  const sidecarPort = 8080
  const cargoTomlPath = ''

  const api: ApiClientOpts = { baseUrl: apiUrl, token: adminToken }
  let runnerId: string | null = null

  try {
    // ─── Stage 1: verify admin token ─────────────────────────────────────
    yield { type: 'stage', stage: 1, total: 7, label: 'Verifying ADMIN token' }
    checkAborted(opts.signal)
    await probeAdminAuth(api, opts.signal)
    yield { type: 'log', line: '→ ADMIN auth OK' }

    // ─── Stage 2: generate runner apiKey ────────────────────────────────
    yield { type: 'stage', stage: 2, total: 7, label: 'Runner credentials prepared' }
    checkAborted(opts.signal)
    yield { type: 'data', key: 'apiKey', value: runnerApiKey }
    yield { type: 'log', line: `apiKey ${runnerApiKey.slice(0, 4)}…${runnerApiKey.slice(-4)}` }

    // ─── Stage 3: POST /api/admin/runners ───────────────────────────────
    yield { type: 'stage', stage: 3, total: 7, label: 'POST /api/admin/runners' }
    checkAborted(opts.signal)
    const r = await createSharedRunner(
      api,
      {
        regionId,
        name: runnerName,
        apiKey: runnerApiKey,
      },
      opts.signal,
    )
    runnerId = r.id
    yield { type: 'data', key: 'runnerId', value: r.id }
    yield { type: 'log', line: `→ runner id=${r.id}` }

    // ─── Stage 4: build user-data ───────────────────────────────────────
    yield { type: 'stage', stage: 4, total: 7, label: 'Building EC2 user-data' }
    checkAborted(opts.signal)
    const userDataBase64 = buildRunnerUserData({
      apiUrl,
      token: runnerApiKey,
      registryUrl,
      runnerPort: 3003,
      withBackupSidecar,
      sidecarPort,
      awsRegion,
      cargoTomlPath,
    })

    // ─── Stage 5: launch EC2 ────────────────────────────────────────────
    yield { type: 'stage', stage: 5, total: 7, label: 'Launching EC2' }
    checkAborted(opts.signal)
    const ec2Client = new EC2Client({ region: awsRegion })
    let ec2Result: Ec2LaunchResult
    try {
      const tags: Record<string, string> = {
        Name: `boxlite-runner-${runnerId!.slice(0, 8)}`,
        RunnerId: runnerId!,
        BoxliteOwner: 'add-shared-runner-lib',
        BoxliteRegion: regionId,
      }
      // Add BoxliteStack if available in environment (CLI use case)
      if (typeof process !== 'undefined' && process.env.BOXLITE_STAGE) {
        tags.BoxliteStack = process.env.BOXLITE_STAGE
      }
      ec2Result = await launchRunnerEc2(ec2Client, {
        subnetId,
        instanceProfileName,
        instanceType,
        rootDiskGB: diskGb,
        userDataBase64,
        tags,
      })
    } catch (e: any) {
      throw e
    }
    yield { type: 'data', key: 'ec2InstanceId', value: ec2Result.instanceId }
    yield { type: 'log', line: `→ instance ${ec2Result.instanceId}, ip=${ec2Result.publicIp ?? '<pending>'}` }

    // ─── Stage 6 & 7: maybe wait ────────────────────────────────────────
    if (noWait) {
      yield { type: 'stage', stage: 6, total: 7, label: 'Result file written' }
      yield { type: 'stage', stage: 7, total: 7, label: '--no-wait: skipping readiness poll' }
      checkAborted(opts.signal)
      return {
        runnerId,
        runnerName,
        apiKey: runnerApiKey,
        ec2InstanceId: ec2Result.instanceId,
        privateIp: ec2Result.privateIp ?? undefined,
        finalState: 'INITIALIZING',
      }
    }

    yield { type: 'stage', stage: 6, total: 7, label: 'Result file written. Polling readiness' }
    checkAborted(opts.signal)

    // ─── Stage 7: poll for READY ────────────────────────────────────────
    yield {
      type: 'stage',
      stage: 7,
      total: 7,
      label: `GET /api/admin/runners/${runnerId} until state=ready (timeout ${timeoutSec}s)`,
    }
    checkAborted(opts.signal)
    const ready = await pollUntilReady(api, runnerId, timeoutSec, opts.signal)
    if (ready) {
      yield { type: 'log', line: `→ READY.` }
      return {
        runnerId,
        runnerName,
        apiKey: runnerApiKey,
        ec2InstanceId: ec2Result.instanceId,
        privateIp: ec2Result.privateIp ?? undefined,
        finalState: 'READY',
      }
    } else {
      yield {
        type: 'warning',
        line: `TIMEOUT waiting for READY. EC2 + runner row exist; investigate.`,
      }
      return {
        runnerId,
        runnerName,
        apiKey: runnerApiKey,
        ec2InstanceId: ec2Result.instanceId,
        privateIp: ec2Result.privateIp ?? undefined,
        finalState: 'TIMEOUT',
      }
    }
  } catch (e: any) {
    if (e instanceof OperationAbortedError) {
      throw e
    }
    if (e instanceof ApiError) {
      if (e.status === 401) {
        yield {
          type: 'warning',
          line: 'BOXLITE_ADMIN_API_KEY is missing/expired. Check the API container startup log.',
        }
      } else if (e.status === 403) {
        yield { type: 'warning', line: 'Token is valid but lacks ADMIN role.' }
      } else if (e.status === 404 && /Region not found/i.test(e.body)) {
        yield {
          type: 'warning',
          line: `Region id '${regionId}' does not exist. Confirm API's DEFAULT_REGION_ID.`,
        }
      }
    }
    throw e
  }
}

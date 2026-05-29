// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import * as crypto from 'crypto'
import type {
  AddSharedRunnerOpts,
  AddSharedRunnerResult,
  ProgressEvent,
} from './runner-ops-types.js'
import { OperationAbortedError } from './runner-ops-types.js'
import type { IInfraProvider } from './infra-provider/types.js'

// ─── Constants ───────────────────────────────────────────────────────────────

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

// ─── Helpers (internal to lib) ──────────────────────────────────────────────

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationAbortedError()
}

async function apiFetch<T>(
  opts: ApiClientOpts,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    signal,
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
      const r = await apiFetch<RunnerFullDto>(api, 'GET', `/api/admin/runners/${runnerId}`, undefined, signal)
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

// ─── Main generator ────────────────────────────────────────────────────────

export async function* addSharedRunner(
  opts: AddSharedRunnerOpts,
  provider: IInfraProvider,
): AsyncGenerator<ProgressEvent, AddSharedRunnerResult, void> {
  checkAborted(opts.signal)

  // Defaults and validation
  const apiUrl = opts.apiUrl
  const adminToken = opts.adminToken
  const regionId = opts.regionId ?? 'us'
  const runnerName = opts.name ?? defaultName()
  const runnerApiKey = opts.apiKey ?? generateRunnerApiKey()
  const instanceType = opts.instanceType ?? 'c8i.2xlarge'
  const diskGb = opts.diskGb ?? 100
  const timeoutSec = opts.timeoutSec ?? 300
  const noWait = opts.noWait ?? false

  const api: ApiClientOpts = { baseUrl: apiUrl, token: adminToken }
  let runnerId: string | null = null
  let provisioned = false

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

    // ─── Stage 4: provision runner host (via IInfraProvider) ────────────
    yield { type: 'stage', stage: 4, total: 7, label: 'Provision runner host' }
    checkAborted(opts.signal)
    const prov = await provider.provisionRunner({
      runnerId: runnerId!,
      apiKey: runnerApiKey,
      apiUrl,
      regionId,
      instanceType,
      diskGb,
    })
    provisioned = true
    const ec2InstanceId = prov.instanceId ?? ''
    const privateIp = prov.endpoint || undefined
    yield { type: 'data', key: 'ec2InstanceId', value: ec2InstanceId }
    yield { type: 'log', line: `→ host provisioned${ec2InstanceId ? `: ${ec2InstanceId}` : ''}${privateIp ? ` (${privateIp})` : ''}` }

    // ─── Stage 5: host launched ─────────────────────────────────────────
    yield { type: 'stage', stage: 5, total: 7, label: 'Runner host launched' }

    // ─── Stage 6 & 7: maybe wait ────────────────────────────────────────
    if (noWait) {
      yield { type: 'stage', stage: 6, total: 7, label: 'Result file written' }
      yield { type: 'stage', stage: 7, total: 7, label: '--no-wait: skipping readiness poll' }
      checkAborted(opts.signal)
      return {
        runnerId,
        runnerName,
        apiKey: runnerApiKey,
        ec2InstanceId,
        privateIp,
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
        ec2InstanceId,
        privateIp,
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
        ec2InstanceId,
        privateIp,
        finalState: 'TIMEOUT',
      }
    }
  } catch (e: any) {
    // Best-effort teardown of partial state: a failed or cancelled add must not
    // leak a half-created runner. Remove the orphan row, and terminate the host
    // if it was provisioned. Uses no AbortSignal so a cancel can't block its own
    // cleanup, and swallows its own errors so it never masks the original `e`.
    // (A slow-but-coming-up runner returns finalState:'TIMEOUT' — a normal
    // return, not a throw — so it never reaches here and is left intact.)
    if (provisioned && runnerId) {
      try {
        await provider.terminateRunner(runnerId)
        yield { type: 'warning', line: `cleanup: terminated provisioned host for runner ${runnerId}` }
      } catch (ce: any) {
        yield { type: 'warning', line: `cleanup: terminate host failed: ${ce?.message ?? ce}` }
      }
    }
    if (runnerId) {
      try {
        // The runner row is created schedulable; DELETE returns 428 ("available
        // for scheduling") unless we cordon it first (same order scale-down uses).
        await apiFetch<unknown>(
          api,
          'PATCH',
          `/api/admin/runners/${runnerId}/scheduling`,
          { unschedulable: true },
          undefined,
        )
        await apiFetch<unknown>(api, 'DELETE', `/api/admin/runners/${runnerId}`, undefined, undefined)
        yield { type: 'warning', line: `cleanup: deleted orphan runner row ${runnerId}` }
      } catch (ce: any) {
        yield { type: 'warning', line: `cleanup: delete runner row failed: ${ce?.message ?? ce}` }
      }
    }
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

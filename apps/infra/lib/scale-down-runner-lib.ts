// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import type {
  ProgressEvent,
  ScaleDownOpts,
  ScaleDownResult,
} from './runner-ops-types.js'
import { OperationAbortedError } from './runner-ops-types.js'
import type { IInfraProvider } from './infra-provider/types.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface ApiClient {
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

interface RunnerDto {
  id: string
  name: string
  state: 'initializing' | 'ready' | 'disabled' | 'decommissioned' | 'unresponsive'
  region: string
  regionType?: 'shared' | 'dedicated' | 'custom'
  unschedulable: boolean
  apiKey: string
  currentStartedSandboxes: number
}

interface SandboxDto {
  id: string
  name: string
  state: string
  desiredState?: string
  runnerId?: string
  region?: string
  snapshot?: string
  backupState?: string
  backupSnapshot?: string
}

interface MigratedSandbox {
  id: string
  name: string
  originalState: string
  fromRunnerId: string
  toRunnerId: string | null
  finalState: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationAbortedError()
}

async function apiFetch<T>(
  api: ApiClient,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  apiPath: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  checkAborted(signal)
  const url = `${api.baseUrl.replace(/\/$/, '')}${apiPath}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new ApiError(res.status, text, method, apiPath)
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Non-JSON response from ${method} ${apiPath}: ${text.slice(0, 200)}`)
  }
}

async function getRunner(api: ApiClient, id: string, signal?: AbortSignal): Promise<RunnerDto> {
  return apiFetch<RunnerDto>(api, 'GET', `/api/admin/runners/${id}`, undefined, {}, signal)
}

async function listRunners(api: ApiClient, signal?: AbortSignal): Promise<RunnerDto[]> {
  return apiFetch<RunnerDto[]>(api, 'GET', `/api/admin/runners`, undefined, {}, signal)
}

async function setScheduling(
  api: ApiClient,
  id: string,
  unschedulable: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch<unknown>(
    api,
    'PATCH',
    `/api/admin/runners/${id}/scheduling`,
    { unschedulable },
    {},
    signal,
  )
}

async function listSandboxesOnRunner(
  api: ApiClient,
  runnerApiKey: string,
  signal?: AbortSignal,
): Promise<SandboxDto[]> {
  checkAborted(signal)
  const url = `${api.baseUrl.replace(/\/$/, '')}/api/sandbox/for-runner`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${runnerApiKey}` },
  })
  if (!res.ok) throw new ApiError(res.status, await res.text(), 'GET', '/api/sandbox/for-runner')
  return (await res.json()) as SandboxDto[]
}

async function getSandbox(api: ApiClient, id: string, signal?: AbortSignal): Promise<SandboxDto> {
  return apiFetch<SandboxDto>(api, 'GET', `/api/sandbox/${id}`, undefined, {}, signal)
}

async function triggerBackupSmart(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<'triggered' | 'already-in-progress' | 'already-complete' | 'skipped'> {
  const s = await getSandbox(api, id, signal)
  const bs = (s.backupState ?? '').toLowerCase()
  if (bs === 'completed') return 'already-complete'
  if (bs === 'pending' || bs === 'in_progress' || bs === 'inprogress')
    return 'already-in-progress'
  try {
    await apiFetch<unknown>(api, 'POST', `/api/sandbox/${id}/backup`, {}, {}, signal)
    return 'triggered'
  } catch (e) {
    if (e instanceof ApiError && e.status === 400 && /already in progress/i.test(e.body)) {
      return 'already-in-progress'
    }
    throw e
  }
}

async function stopSandbox(api: ApiClient, id: string, signal?: AbortSignal): Promise<void> {
  await apiFetch<unknown>(api, 'POST', `/api/sandbox/${id}/stop`, {}, {}, signal)
}

async function archiveSandbox(api: ApiClient, id: string, signal?: AbortSignal): Promise<void> {
  await apiFetch<unknown>(api, 'POST', `/api/sandbox/${id}/archive`, {}, {}, signal)
}

async function startSandbox(api: ApiClient, id: string, signal?: AbortSignal): Promise<void> {
  await apiFetch<unknown>(api, 'POST', `/api/sandbox/${id}/start`, {}, {}, signal)
}

async function waitFor<T>(
  desc: string,
  fn: () => Promise<T | null>,
  timeoutSec: number,
  intervalMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutSec * 1000
  let last: T | null = null
  while (Date.now() < deadline) {
    last = await fn()
    if (last !== null) return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timeout waiting for ${desc} (${timeoutSec}s). Last value: ${JSON.stringify(last)}`)
}

async function waitBackupCompleted(
  api: ApiClient,
  sid: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<'completed' | 'error'> {
  const result = await waitFor<{ s: SandboxDto; outcome: 'completed' | 'error' }>(
    `backup of ${sid} to COMPLETED`,
    async () => {
      const s = await getSandbox(api, sid, signal)
      const bs = (s.backupState ?? '').toLowerCase()
      if (bs === 'completed') return { s, outcome: 'completed' }
      if (bs === 'error') return { s, outcome: 'error' }
      return null
    },
    timeoutSec,
  )
  return result.outcome
}

async function waitArchivedAndDetached(
  api: ApiClient,
  sid: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<SandboxDto> {
  return waitFor<SandboxDto>(
    `sandbox ${sid} state=archived AND runnerId=null`,
    async () => {
      const s = await getSandbox(api, sid, signal)
      if (s.state === 'archived' && !s.runnerId) return s
      if (s.state === 'error' || s.state === 'build_failed') {
        throw new Error(`Sandbox ${sid} entered terminal state ${s.state} during archive.`)
      }
      return null
    },
    timeoutSec,
  )
}

async function waitSandboxState(
  api: ApiClient,
  sid: string,
  desired: string | string[],
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<SandboxDto> {
  const want = Array.isArray(desired) ? desired : [desired]
  const terminalBad = ['error', 'build_failed']
  return waitFor<SandboxDto>(
    `sandbox ${sid} state ∈ {${want.join(',')}}`,
    async () => {
      const s = await getSandbox(api, sid, signal)
      if (want.includes(s.state)) return s
      if (terminalBad.includes(s.state) && !want.includes(s.state)) {
        throw new Error(`Sandbox ${sid} entered terminal state ${s.state}.`)
      }
      return null
    },
    timeoutSec,
  )
}

// ─── Main generator ─────────────────────────────────────────────────────────

export async function* scaleDownRunner(
  opts: ScaleDownOpts,
  provider: IInfraProvider,
): AsyncGenerator<ProgressEvent, ScaleDownResult, void> {
  const start = Date.now()
  checkAborted(opts.signal)

  const maxWaitBackupSec = opts.maxWaitBackupSec ?? 900
  const maxWaitStopSec = opts.maxWaitStopSec ?? 120
  const maxWaitArchiveSec = opts.maxWaitArchiveSec ?? 300
  const maxWaitStartSec = opts.maxWaitStartSec ?? 900
  const maxWaitDrainSec = 900

  const api: ApiClient = { baseUrl: opts.apiUrl, token: opts.adminToken }

  const migrations: MigratedSandbox[] = []
  const ec2InstancesTerminated: string[] = []

  try {
    // ─── [1/10] Preflight ─────────────────────────────────────────────────
    yield { type: 'stage', stage: 1, total: 10, label: 'Preflight' }
    checkAborted(opts.signal)
    const src = await getRunner(api, opts.runnerId, opts.signal)

    if (src.regionType !== 'shared') {
      throw new Error(
        `Runner regionType='${src.regionType}'; scope is SHARED-only.`,
      )
    }
    if (src.state !== 'ready') {
      yield { type: 'warning', line: `runner state='${src.state}' (expected 'ready'). Continuing.` }
    }
    yield { type: 'log', line: `source: ${src.name} (${src.id}) region=${src.region} (shared)` }

    // Peer pool
    const all = await listRunners(api, opts.signal)
    const peers = all.filter(
      (r) =>
        r.id !== src.id &&
        r.region === src.region &&
        r.regionType === 'shared' &&
        r.state === 'ready' &&
        !r.unschedulable,
    )
    yield {
      type: 'log',
      line: `peer pool (shared, ready, schedulable, region=${src.region}): ${peers.length}`,
    }
    for (const p of peers) {
      yield { type: 'log', line: `  - ${p.name} (${p.id})` }
    }

    // Emit preflight data for CLI confirmation/result tracking
    if (!src.apiKey) {
      throw new Error(`Source runner row is missing apiKey; cannot list sandboxes.`)
    }
    yield { type: 'data', key: 'sourceApiKey', value: src.apiKey }
    yield { type: 'data', key: 'sourceRunnerName', value: src.name }
    yield { type: 'data', key: 'sourceRegion', value: src.region }
    yield { type: 'data', key: 'peerCount', value: peers.length }
    yield { type: 'data', key: 'peers', value: peers }

    // #3: a scale-down with no peer in the region cannot migrate the boxes.
    // Assert BEFORE the dryRun early-return so dryRun correctly reports the
    // runner is not scalable-down (FAILED), not a misleading SUCCESS.
    if (peers.length === 0) {
      throw new Error(
        `no peer SHARED runner (ready, schedulable) in region ${src.region}; cannot scale down (boxes have nowhere to migrate)`,
      )
    }

    if (opts.dryRun) {
      return {
        runnerId: opts.runnerId,
        sandboxesMigrated: [],
        sandboxesArchived: [],
        ec2InstancesTerminated: [],
        durationMs: Date.now() - start,
      }
    }

    // ─── [2/10] Cordon ────────────────────────────────────────────────────
    yield { type: 'stage', stage: 2, total: 10, label: 'Cordon source runner' }
    checkAborted(opts.signal)
    await setScheduling(api, src.id, true, opts.signal)
    yield { type: 'log', line: 'runner cordoned' }

    // ─── [3/10] Enumerate sandboxes ────────────────────────────────────────
    yield { type: 'stage', stage: 3, total: 10, label: 'Enumerate sandboxes on source' }
    checkAborted(opts.signal)
    const all_sandboxes = await listSandboxesOnRunner(api, src.apiKey, opts.signal)
    const TERMINAL = new Set(['archived', 'destroyed', 'destroying'])
    const STARTED_LIKE = new Set(['started'])
    const STOPPED_LIKE = new Set(['stopped'])

    const started: SandboxDto[] = []
    const stopped: SandboxDto[] = []
    const skipped: SandboxDto[] = []
    for (const sb of all_sandboxes) {
      if (TERMINAL.has(sb.state)) continue
      if (STARTED_LIKE.has(sb.state)) started.push(sb)
      else if (STOPPED_LIKE.has(sb.state)) stopped.push(sb)
      else skipped.push(sb)
    }
    yield {
      type: 'log',
      line: `found: started=${started.length} stopped=${stopped.length} skipped(transient/error)=${skipped.length}`,
    }
    if (skipped.length > 0) {
      for (const s of skipped) {
        yield { type: 'log', line: `SKIP ${s.id} (state=${s.state})` }
      }
    }

    // Emit enumeration data for ResultWriter
    yield { type: 'data', key: 'sandboxesStarted', value: started }
    yield { type: 'data', key: 'sandboxesStopped', value: stopped }
    yield { type: 'data', key: 'sandboxesSkipped', value: skipped }

    // Pre-record originals for migration tracking
    for (const sb of [...started, ...stopped]) {
      migrations.push({
        id: sb.id,
        name: sb.name,
        originalState: sb.state,
        fromRunnerId: src.id,
        toRunnerId: null,
        finalState: '',
      })
    }

    if (started.length === 0 && stopped.length === 0) {
      yield { type: 'log', line: '(no sandboxes to migrate)' }
    }

    // ─── [4/10] Stop STARTED sandboxes ────────────────────────────────────
    if (started.length > 0) {
      yield { type: 'stage', stage: 4, total: 10, label: `Stop ${started.length} STARTED sandbox(es)` }
      checkAborted(opts.signal)
      for (const sb of started) {
        yield { type: 'log', line: `stop ${sb.id}…` }
        try {
          await stopSandbox(api, sb.id, opts.signal)
          await waitSandboxState(api, sb.id, 'stopped', maxWaitStopSec, opts.signal)
          yield { type: 'log', line: '  ✓ STOPPED' }
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e)
          yield { type: 'log', line: `  FAIL: ${msg}` }
          throw new Error(`stop ${sb.id}: ${msg}`)
        }
      }
    } else {
      yield { type: 'stage', stage: 4, total: 10, label: 'No STARTED sandboxes; skip stop stage' }
    }

    // ─── [5/10] Force backup (now-STOPPED) sandboxes ──────────────────────
    const toBackup = [...started, ...stopped]
    if (toBackup.length > 0) {
      yield {
        type: 'stage',
        stage: 5,
        total: 10,
        label: `Ensure backup COMPLETED for ${toBackup.length} sandbox(es)`,
      }
      checkAborted(opts.signal)
      for (const sb of toBackup) {
        yield { type: 'log', line: `${sb.id} (${sb.name})…` }
        try {
          const status = await triggerBackupSmart(api, sb.id, opts.signal)
          yield { type: 'log', line: `  status=${status}` }
          if (status === 'already-complete') {
            yield { type: 'log', line: '  ✓ already COMPLETED, skipping' }
            continue
          }
          let outcome = await waitBackupCompleted(api, sb.id, maxWaitBackupSec, opts.signal)
          if (outcome === 'error') {
            yield { type: 'log', line: '  backup ended in ERROR; retrying once…' }
            await triggerBackupSmart(api, sb.id, opts.signal)
            outcome = await waitBackupCompleted(api, sb.id, maxWaitBackupSec, opts.signal)
          }
          if (outcome === 'completed') {
            yield { type: 'log', line: '  ✓ backup COMPLETED' }
          } else {
            throw new Error(`backup of ${sb.id} ended in ERROR after retry; aborting`)
          }
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e)
          yield { type: 'log', line: `  FAIL: ${msg}` }
          throw new Error(`backup ${sb.id}: ${msg}`)
        }
      }
    } else {
      yield { type: 'stage', stage: 5, total: 10, label: 'No sandboxes to back up' }
    }

    // ─── [6/10] Archive all (now-STOPPED) ──────────────────────────────────
    const toArchive = [...started, ...stopped]
    if (toArchive.length > 0) {
      yield {
        type: 'stage',
        stage: 6,
        total: 10,
        label: `Archive ${toArchive.length} sandbox(es) (wait for runnerId=null)`,
      }
      checkAborted(opts.signal)
      for (const sb of toArchive) {
        yield { type: 'log', line: `archive ${sb.id}…` }
        try {
          await archiveSandbox(api, sb.id, opts.signal)
          const archived = await waitArchivedAndDetached(api, sb.id, maxWaitArchiveSec, opts.signal)
          if (archived.runnerId) {
            throw new Error(
              `Sandbox ${sb.id} state=archived but runnerId still set to ${archived.runnerId}.`,
            )
          }
          yield { type: 'log', line: '  ✓ ARCHIVED and detached (runnerId=null)' }
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e)
          yield { type: 'log', line: `  FAIL: ${msg}` }
          throw new Error(`archive ${sb.id}: ${msg}`)
        }
      }
    } else {
      yield { type: 'stage', stage: 6, total: 10, label: 'No sandboxes to archive' }
    }

    // ─── [7/10] Restart (live migrate) ────────────────────────────────────
    const toRestart = opts.restartStopped ? [...started, ...stopped] : started
    if (toRestart.length > 0) {
      yield {
        type: 'stage',
        stage: 7,
        total: 10,
        label: `Restart ${toRestart.length} sandbox(es) on peer runner(s)`,
      }
      checkAborted(opts.signal)
      for (const sb of toRestart) {
        yield { type: 'log', line: `start ${sb.id}…` }
        try {
          const pre = await getSandbox(api, sb.id, opts.signal)
          if (pre.runnerId) {
            throw new Error(
              `Pre-start check failed: sandbox ${sb.id} still has runnerId=${pre.runnerId}. Archive stage didn't detach.`,
            )
          }
          await startSandbox(api, sb.id, opts.signal)
          const restored = await waitSandboxState(api, sb.id, 'started', maxWaitStartSec, opts.signal)

          // Verify boundary
          if (!restored.runnerId || restored.runnerId === src.id) {
            throw new Error(`Sandbox ${sb.id} did not move off source (runnerId=${restored.runnerId}).`)
          }
          const dst = all.find((r) => r.id === restored.runnerId)
          const dstRunner = dst ?? (await getRunner(api, restored.runnerId, opts.signal))
          if (dstRunner.regionType !== 'shared') {
            throw new Error(
              `Sandbox ${sb.id} restored on non-shared runner (regionType=${dstRunner.regionType}). Boundary violation!`,
            )
          }
          if (dstRunner.region !== src.region) {
            throw new Error(`Sandbox ${sb.id} crossed regions: ${src.region} → ${dstRunner.region}.`)
          }
          yield { type: 'log', line: `  ✓ STARTED on ${dstRunner.name} (${dstRunner.id.slice(0, 8)})` }

          // Update migration record
          const m = migrations.find((x) => x.id === sb.id)
          if (m) {
            m.toRunnerId = dstRunner.id
            m.finalState = 'started'
          }
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e)
          yield { type: 'warning', line: `${msg}` }
          const m = migrations.find((x) => x.id === sb.id)
          if (m) m.finalState = 'failed-to-restart'
        }
      }
    } else {
      yield { type: 'stage', stage: 7, total: 10, label: 'No sandboxes to restart' }
    }

    // ─── [8/10] Wait runner drainable ──────────────────────────────────────
    yield {
      type: 'stage',
      stage: 8,
      total: 10,
      label: 'Wait until source has 0 non-archived/destroyed sandboxes',
    }
    checkAborted(opts.signal)
    const deadline8 = Date.now() + maxWaitDrainSec * 1000
    let drainable = false
    while (Date.now() < deadline8) {
      const fresh = await getRunner(api, src.id, opts.signal)
      if (fresh.currentStartedSandboxes === 0) {
        drainable = true
        break
      }
      await new Promise((r) => setTimeout(r, 5000))
    }
    if (!drainable) {
      yield { type: 'warning', line: 'drain wait timed out; will try DELETE anyway.' }
    }

    // ─── [9/10] DELETE runner row ──────────────────────────────────────────
    yield { type: 'stage', stage: 9, total: 10, label: `DELETE /api/admin/runners/${src.id}` }
    checkAborted(opts.signal)
    try {
      await apiFetch<unknown>(api, 'DELETE', `/api/admin/runners/${src.id}`, undefined, {}, opts.signal)
      yield { type: 'log', line: '✓ runner row deleted' }
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e)
      yield { type: 'log', line: `✗ DELETE failed: ${msg}` }
      throw new Error(`DELETE runner: ${msg}`)
    }

    // ─── [10/10] Terminate runner host (via IInfraProvider) ───────────────
    const skip = opts.skipTerminate ?? opts.skipEc2Terminate ?? false
    if (skip) {
      yield { type: 'stage', stage: 10, total: 10, label: 'skipTerminate: leaving runner host running' }
    } else {
      yield { type: 'stage', stage: 10, total: 10, label: `Terminate runner host for ${src.id}` }
      checkAborted(opts.signal)
      await provider.terminateRunner(src.id)
      ec2InstancesTerminated.push(src.id)
      yield { type: 'log', line: `→ host terminated for runner ${src.id}` }
    }

    // Determine which sandboxes migrated vs archived
    const sandboxesMigrated = migrations.filter((m) => m.toRunnerId).map((m) => m.id)
    const sandboxesArchived = migrations.filter((m) => !m.toRunnerId).map((m) => m.id)

    return {
      runnerId: opts.runnerId,
      sandboxesMigrated,
      sandboxesArchived,
      ec2InstancesTerminated,
      durationMs: Date.now() - start,
    }
  } catch (e: unknown) {
    // Re-throw so the CLI can handle it
    throw e
  }
}

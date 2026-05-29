import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { addSharedRunner } from '../add-shared-runner-lib'
import type { ProgressEvent } from '../runner-ops-types'
import type { IInfraProvider } from '../infra-provider/types'

const mockFetch: any = jest.fn()
;(globalThis as any).fetch = mockFetch

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response
}

function fakeProvider(): IInfraProvider {
  return {
    provisionRunner: jest.fn(async () => ({ endpoint: '10.0.0.1', instanceId: 'i-abc123' })),
    terminateRunner: jest.fn(async () => {}),
    describeRunner: jest.fn(async () => ({ alive: true })),
  } as unknown as IInfraProvider
}

beforeEach(() => { mockFetch.mockReset() })

describe('addSharedRunner generator', () => {
  it('throws OperationAbortedError when signal is pre-aborted', async () => {
    const c = new AbortController()
    c.abort()
    const gen = addSharedRunner(
      { apiUrl: 'http://api', adminToken: 'tok', awsRegion: 'us-east-1', signal: c.signal },
      fakeProvider(),
    )
    await expect(gen.next()).rejects.toThrow(/aborted/i)
  })

  it('calls provider.provisionRunner and yields stage/data events on happy path', async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ id: 'u-1', role: 'admin' })) // probe auth (GET /admin/runners)
      .mockResolvedValueOnce(okResponse({ id: 'r-1', name: 'r', apiKey: 'k', region: 'us' })) // POST create
      .mockResolvedValueOnce(okResponse({ id: 'r-1', state: 'ready' })) // poll ready
    const provider = fakeProvider()
    const events: ProgressEvent[] = []
    const gen = addSharedRunner(
      { apiUrl: 'http://api', adminToken: 'tok', awsRegion: 'us-east-1', name: 'r', apiKey: 'k', timeoutSec: 5 },
      provider,
    )
    let result
    while (true) {
      const n = await gen.next()
      if (n.done) { result = n.value; break }
      // n is a yield (not the return) past the guard; non-strict tsconfig can't
      // discriminate IteratorResult on `done`, so assert the narrowed type.
      events.push(n.value as ProgressEvent)
      if (events.length > 50) break
    }
    expect(provider.provisionRunner).toHaveBeenCalledTimes(1)
    expect((provider.provisionRunner as jest.Mock).mock.calls[0][0]).toMatchObject({ runnerId: 'r-1', apiUrl: 'http://api' })
    expect(result?.runnerId).toBe('r-1')
    // ec2InstanceId carries the real instance id; the IP goes in privateIp.
    expect(result?.ec2InstanceId).toBe('i-abc123')
    expect(result?.privateIp).toBe('10.0.0.1')
    // apiKey never leaks into a log line
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as any).line).join('\n')
    expect(logs).not.toMatch(/[A-Za-z0-9_-]{40,}/)
  })

  it('deletes the orphan runner row when provisioning fails (no host to terminate)', async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ id: 'u-1', role: 'admin' })) // probe auth
      .mockResolvedValueOnce(okResponse({ id: 'r-1', name: 'r', apiKey: 'k', region: 'us' })) // POST create
      .mockResolvedValueOnce(okResponse({})) // cleanup DELETE /admin/runners/r-1
    const provider = fakeProvider()
    ;(provider.provisionRunner as jest.Mock).mockRejectedValueOnce(new Error('RunInstances denied') as never)
    const events: ProgressEvent[] = []
    const gen = addSharedRunner(
      { apiUrl: 'http://api', adminToken: 'tok', awsRegion: 'us-east-1', name: 'r', apiKey: 'k', timeoutSec: 5 },
      provider,
    )
    await expect(
      (async () => {
        for (;;) {
          const n = await gen.next()
          if (n.done) return
          events.push(n.value as ProgressEvent)
          if (events.length > 50) throw new Error('runaway generator')
        }
      })(),
    ).rejects.toThrow(/RunInstances denied/)
    // Host was never provisioned → not terminated; orphan row IS deleted.
    expect(provider.terminateRunner).not.toHaveBeenCalled()
    const deleteCall = mockFetch.mock.calls.find((c: any[]) => c[1]?.method === 'DELETE')
    expect(deleteCall?.[0]).toContain('/api/admin/runners/r-1')
    const warns = events.filter((e) => e.type === 'warning').map((e) => (e as any).line).join('\n')
    expect(warns).toMatch(/deleted orphan runner row r-1/)
  })

  it('terminates the host AND deletes the row when a cancel arrives after provisioning', async () => {
    const controller = new AbortController()
    mockFetch
      .mockResolvedValueOnce(okResponse({ id: 'u-1', role: 'admin' })) // probe auth
      .mockResolvedValueOnce(okResponse({ id: 'r-1', name: 'r', apiKey: 'k', region: 'us' })) // POST create
      .mockResolvedValueOnce(okResponse({})) // cleanup DELETE
    const provider = fakeProvider()
    // Abort right after provisioning so the next checkAborted unwinds into cleanup.
    ;(provider.provisionRunner as jest.Mock).mockImplementationOnce(async () => {
      controller.abort()
      return { endpoint: '10.0.0.1', instanceId: 'i-abc123' }
    })
    const events: ProgressEvent[] = []
    const gen = addSharedRunner(
      { apiUrl: 'http://api', adminToken: 'tok', awsRegion: 'us-east-1', name: 'r', apiKey: 'k', signal: controller.signal },
      provider,
    )
    await expect(
      (async () => {
        for (;;) {
          const n = await gen.next()
          if (n.done) return
          events.push(n.value as ProgressEvent)
          if (events.length > 50) throw new Error('runaway generator')
        }
      })(),
    ).rejects.toThrow(/aborted/i)
    expect(provider.terminateRunner).toHaveBeenCalledWith('r-1')
    const deleteCall = mockFetch.mock.calls.find((c: any[]) => c[1]?.method === 'DELETE')
    expect(deleteCall?.[0]).toContain('/api/admin/runners/r-1')
  })
})

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
    provisionRunner: jest.fn(async () => ({ endpoint: '10.0.0.1' })),
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
    expect(result?.ec2InstanceId).toBe('10.0.0.1')
    // apiKey never leaks into a log line
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as any).line).join('\n')
    expect(logs).not.toMatch(/[A-Za-z0-9_-]{40,}/)
  })
})

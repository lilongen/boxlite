import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { scaleDownRunner } from '../scale-down-runner-lib'
import type { ProgressEvent } from '../runner-ops-types'
import type { IInfraProvider } from '../infra-provider/types'

const mockFetch: any = jest.fn()
;(globalThis as any).fetch = mockFetch

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response
}

function mockProvider(): IInfraProvider & {
  terminateRunner: jest.Mock
  provisionRunner: jest.Mock
  describeRunner: jest.Mock
} {
  return {
    provisionRunner: jest.fn(async () => ({})),
    terminateRunner: jest.fn(async () => {}),
    describeRunner: jest.fn(async () => ({ alive: true })),
  } as any
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('scaleDownRunner generator', () => {
  it('preflight rejects non-SHARED runner', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({
        id: 'r-1',
        state: 'ready',
        regionType: 'custom',
        apiKey: 'k',
        currentStartedSandboxes: 0,
        region: 'us',
      }),
    )
    const gen = scaleDownRunner(
      {
        apiUrl: 'http://api',
        adminToken: 't',
        awsRegion: 'us-1',
        runnerId: 'r-1',
        dryRun: true,
      },
      mockProvider(),
    )
    let saw = false
    try {
      while (true) {
        const n = await gen.next()
        if (n.done) break
      }
    } catch (e: any) {
      saw = /SHARED|shared/.test(e.message)
    }
    expect(saw).toBe(true)
  })

  it('dry-run with no peer in region throws (cannot migrate)', async () => {
    // preflight: r-1 is a valid SHARED ready runner …
    mockFetch
      .mockResolvedValueOnce(
        okResponse({
          id: 'r-1',
          state: 'ready',
          regionType: 'shared',
          apiKey: 'k',
          currentStartedSandboxes: 0,
          region: 'us',
        }),
      )
      // … but the runner list contains ONLY itself → zero peers.
      .mockResolvedValueOnce(okResponse([{ id: 'r-1', state: 'ready', regionType: 'shared', region: 'us' }]))

    const provider = mockProvider()
    const gen = scaleDownRunner(
      {
        apiUrl: 'http://api',
        adminToken: 't',
        awsRegion: 'us-1',
        runnerId: 'r-1',
        dryRun: true,
      },
      provider,
    )
    let sawNoPeer = false
    try {
      while (true) {
        const n = await gen.next()
        if (n.done) break
      }
    } catch (e: any) {
      sawNoPeer = /no peer/i.test(e.message)
    }
    expect(sawNoPeer).toBe(true)
    // dryRun must not terminate anything regardless.
    expect(provider.terminateRunner).not.toHaveBeenCalled()
  })

  it('dry-run with a valid peer returns result without side-effects', async () => {
    mockFetch
      .mockResolvedValueOnce(
        okResponse({
          id: 'r-1',
          state: 'ready',
          regionType: 'shared',
          apiKey: 'k',
          currentStartedSandboxes: 0,
          region: 'us',
        }),
      )
      .mockResolvedValueOnce(
        okResponse([
          { id: 'r-2', state: 'ready', regionType: 'shared', region: 'us' },
          { id: 'r-1', state: 'ready', regionType: 'shared', region: 'us' },
        ]),
      )
    const provider = mockProvider()
    const events: ProgressEvent[] = []
    const gen = scaleDownRunner(
      {
        apiUrl: 'http://api',
        adminToken: 't',
        awsRegion: 'us-1',
        runnerId: 'r-1',
        dryRun: true,
      },
      provider,
    )
    let result
    while (true) {
      const n = await gen.next()
      if (n.done) {
        result = n.value
        break
      }
      events.push(n.value)
      if (events.length > 20) break
    }
    expect(result?.runnerId).toBe('r-1')
    expect(events.some((e) => e.type === 'stage' && e.stage === 1)).toBe(true)
    expect(provider.terminateRunner).not.toHaveBeenCalled()
  })
})

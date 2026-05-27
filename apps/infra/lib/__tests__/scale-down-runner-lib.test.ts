import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { scaleDownRunner } from '../scale-down-runner-lib'
import type { ProgressEvent, ScaleDownOpts } from '../runner-ops-types'

const mockFetch = jest.fn()
;(globalThis as any).fetch = mockFetch

jest.mock('@aws-sdk/client-ec2', () => {
  const send = jest.fn()
  return {
    EC2Client: jest.fn(() => ({ send })),
    DescribeInstancesCommand: jest.fn((x) => ({ __cmd: 'DescribeInstances', input: x })),
    TerminateInstancesCommand: jest.fn((x) => ({ __cmd: 'TerminateInstances', input: x })),
    __send: send,
  }
})
const ec2 = jest.requireMock('@aws-sdk/client-ec2') as any

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response
}

beforeEach(() => {
  mockFetch.mockReset()
  ec2.__send.mockReset()
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
    const gen = scaleDownRunner({
      apiUrl: 'http://api',
      adminToken: 't',
      awsRegion: 'us-1',
      runnerId: 'r-1',
      dryRun: true,
    })
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

  it('dry-run with valid preflight returns result without side-effects', async () => {
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
    const events: ProgressEvent[] = []
    const gen = scaleDownRunner({
      apiUrl: 'http://api',
      adminToken: 't',
      awsRegion: 'us-1',
      runnerId: 'r-1',
      dryRun: true,
    })
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
  })
})

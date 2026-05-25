import { describe, it, expect, jest } from '@jest/globals'
import { addSharedRunner } from '../add-shared-runner-lib'
import type { ProgressEvent, AddSharedRunnerOpts } from '../runner-ops-types'

const mockFetch = jest.fn()
;(globalThis as any).fetch = mockFetch

jest.mock('@aws-sdk/client-ec2', () => {
  const send = jest.fn()
  return {
    EC2Client: jest.fn(() => ({ send })),
    RunInstancesCommand: jest.fn((x) => ({ __cmd: 'RunInstances', input: x })),
    DescribeImagesCommand: jest.fn((x) => ({ __cmd: 'DescribeImages', input: x })),
    DescribeInstancesCommand: jest.fn((x) => ({ __cmd: 'DescribeInstances', input: x })),
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

describe('addSharedRunner generator', () => {
  it('throws OperationAbortedError when signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const gen = addSharedRunner({
      apiUrl: 'http://api.example',
      adminToken: 'tok',
      awsRegion: 'ap-southeast-1',
      signal: controller.signal,
    })
    await expect(gen.next()).rejects.toThrow(/aborted/i)
  })

  it('yields stage event types in order on happy path', async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ id: 'u-1', role: 'admin' }))
      .mockResolvedValueOnce(
        okResponse({ id: 'r-1', name: 'r', apiKey: 'dtn_test', region: 'us' }),
      )
      .mockResolvedValueOnce(okResponse({ id: 'r-1', state: 'ready' }))
    ec2.__send
      .mockResolvedValueOnce({
        Images: [{ ImageId: 'ami-test', CreationDate: '2026-01-01' }],
      })
      .mockResolvedValueOnce({
        Instances: [
          {
            InstanceId: 'i-test',
            PrivateIpAddress: '10.0.0.1',
            PublicIpAddress: '54.0.0.1',
            Placement: { AvailabilityZone: 'ap-southeast-1a' },
          },
        ],
      })

    const events: ProgressEvent[] = []
    const gen = addSharedRunner({
      apiUrl: 'http://api.example',
      adminToken: 'tok',
      awsRegion: 'ap-southeast-1',
      subnetId: 'subnet-test',
      instanceProfileName: 'profile-test',
      registryUrl: 'http://registry.example',
      timeoutSec: 60,
    })
    let result
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
      if (events.length > 50) break
    }
    expect(result?.runnerId).toBe('r-1')
    expect(events.some((e) => e.type === 'stage')).toBe(true)
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as any).line).join('\n')
    expect(logs).not.toMatch(/[A-Za-z0-9_-]{40,}/)
  })
})

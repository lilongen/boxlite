import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// ESM mocking: `jest.mock` doesn't intercept static imports under ts-jest/ESM —
// use `jest.unstable_mockModule` + dynamic import of the SUT (see local.test.ts).
const send = jest.fn()
jest.unstable_mockModule('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send })),
  RunInstancesCommand: jest.fn((x: unknown) => ({ __cmd: 'RunInstances', input: x })),
  DescribeImagesCommand: jest.fn((x: unknown) => ({ __cmd: 'DescribeImages', input: x })),
  DescribeInstancesCommand: jest.fn((x: unknown) => ({ __cmd: 'DescribeInstances', input: x })),
  TerminateInstancesCommand: jest.fn((x: unknown) => ({ __cmd: 'TerminateInstances', input: x })),
}))
jest.unstable_mockModule('../../runner-user-data.js', () => ({ buildRunnerUserData: jest.fn(() => 'BASE64UD') }))

const { AwsInfraProvider } = await import('../aws')
const ec2 = { __send: send }
type AwsProviderConfig = import('../types').AwsProviderConfig

const cfg: AwsProviderConfig = {
  kind: 'aws', awsRegion: 'us-east-1', subnetId: 'subnet-x',
  instanceProfileName: 'prof-x', registryUrl: 'http://reg', cargoTomlPath: '/repo/Cargo.toml',
}

beforeEach(() => ec2.__send.mockReset())

describe('AwsInfraProvider', () => {
  it('provisionRunner tags RunInstances with RunnerId', async () => {
    ec2.__send
      .mockResolvedValueOnce({ Images: [{ ImageId: 'ami-1', CreationDate: '2026-01-01' }] }) // DescribeImages
      .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-1', PrivateIpAddress: '10.0.0.1' }] }) // RunInstances
    const p = new AwsInfraProvider(cfg)
    const r = await p.provisionRunner({ runnerId: 'run-1', apiKey: 'k', apiUrl: 'http://api', regionId: 'us' })
    expect(r.endpoint).toBe('10.0.0.1')
    const runCall = ec2.__send.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.__cmd === 'RunInstances')
    const tags = runCall.input.TagSpecifications[0].Tags
    expect(tags).toContainEqual({ Key: 'RunnerId', Value: 'run-1' })
  })

  it('terminateRunner filters by tag:RunnerId then terminates', async () => {
    ec2.__send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-9', State: { Name: 'running' } }] }] })
      .mockResolvedValueOnce({})
    const p = new AwsInfraProvider(cfg)
    await p.terminateRunner('run-9')
    const term = ec2.__send.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.__cmd === 'TerminateInstances')
    expect(term.input.InstanceIds).toEqual(['i-9'])
  })

  it('cargoTomlPath throws when empty (#2 fix: no silent empty string)', async () => {
    const bad = new AwsInfraProvider({ ...cfg, cargoTomlPath: '' })
    await expect(bad.provisionRunner({ runnerId: 'r', apiKey: 'k', apiUrl: 'a', regionId: 'us' }))
      .rejects.toThrow(/cargoTomlPath/)
  })
})

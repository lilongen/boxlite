import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// ESM mocking: `jest.mock` doesn't intercept static imports under ts-jest/ESM —
// use `jest.unstable_mockModule` + dynamic import of the SUT (see local.test.ts).
// Typed so `.mockResolvedValueOnce(...)` accepts the EC2 response shapes
// (an untyped jest.fn() infers a `never` argument under @jest/globals).
const send = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send })),
  RunInstancesCommand: jest.fn((x: unknown) => ({ __cmd: 'RunInstances', input: x })),
  DescribeImagesCommand: jest.fn((x: unknown) => ({ __cmd: 'DescribeImages', input: x })),
  DescribeInstancesCommand: jest.fn((x: unknown) => ({ __cmd: 'DescribeInstances', input: x })),
  TerminateInstancesCommand: jest.fn((x: unknown) => ({ __cmd: 'TerminateInstances', input: x })),
}))
const buildUserData = jest.fn((..._args: any[]) => 'BASE64UD')
jest.unstable_mockModule('../../runner-user-data.js', () => ({ buildRunnerUserData: buildUserData }))

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

  it('provisionRunner threads withBackupSidecar + backupsBucket into the runner user-data', async () => {
    ec2.__send
      .mockResolvedValueOnce({ Images: [{ ImageId: 'ami-1', CreationDate: '2026-01-01' }] })
      .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-1', PrivateIpAddress: '10.0.0.1' }] })
    buildUserData.mockClear()
    const p = new AwsInfraProvider(cfg)
    await p.provisionRunner({
      runnerId: 'run-b', apiKey: 'k', apiUrl: 'http://api', regionId: 'us',
      withBackupSidecar: true, backupsBucket: 'boxlite-volume-backups-dev',
    })
    // Regression guard: the bucket must reach buildRunnerUserData, else the
    // runner launches without BOXLITE_BACKUPS_BUCKET and scale-down backup fails.
    expect(buildUserData).toHaveBeenCalledWith(
      expect.objectContaining({ withBackupSidecar: true, backupsBucket: 'boxlite-volume-backups-dev' }),
    )
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

  it('describeRunner reports alive for a running tagged instance', async () => {
    ec2.__send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: 'i-7', State: { Name: 'running' } }] }],
    })
    const p = new AwsInfraProvider(cfg)
    expect(await p.describeRunner('run-7')).toEqual({ alive: true })
    const desc = ec2.__send.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.__cmd === 'DescribeInstances')
    expect(desc.input.Filters).toContainEqual({ Name: 'tag:RunnerId', Values: ['run-7'] })
  })

  it('describeRunner reports not-alive when the only instance is terminated', async () => {
    ec2.__send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: 'i-8', State: { Name: 'terminated' } }] }],
    })
    const p = new AwsInfraProvider(cfg)
    expect(await p.describeRunner('run-8')).toEqual({ alive: false })
  })
})

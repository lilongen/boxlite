import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { AwsInfraProvider } from '../aws'
import type { AwsProviderConfig } from '../types'

jest.mock('@aws-sdk/client-ec2', () => {
  const send = jest.fn()
  return {
    EC2Client: jest.fn(() => ({ send })),
    RunInstancesCommand: jest.fn((x) => ({ __cmd: 'RunInstances', input: x })),
    DescribeImagesCommand: jest.fn((x) => ({ __cmd: 'DescribeImages', input: x })),
    DescribeInstancesCommand: jest.fn((x) => ({ __cmd: 'DescribeInstances', input: x })),
    TerminateInstancesCommand: jest.fn((x) => ({ __cmd: 'TerminateInstances', input: x })),
    __send: send,
  }
})
jest.mock('../runner-user-data', () => ({ buildRunnerUserData: jest.fn(() => 'BASE64UD') }))
const ec2 = jest.requireMock('@aws-sdk/client-ec2') as any

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

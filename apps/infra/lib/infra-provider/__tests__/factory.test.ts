import { describe, it, expect } from '@jest/globals'
import { createInfraProvider } from '../factory'
import { AwsInfraProvider } from '../aws'
import { LocalProcessInfraProvider } from '../local'

describe('createInfraProvider', () => {
  it("returns LocalProcessInfraProvider for kind 'local'", () => {
    const p = createInfraProvider({
      kind: 'local', runnerBin: '/x', homeRoot: '/tmp', portBase: 3100,
      insecureRegistries: '', terminateGraceSec: 1, apiUrl: 'a', backupRegion: 'us-east-1',
    })
    expect(p).toBeInstanceOf(LocalProcessInfraProvider)
  })
  it("returns AwsInfraProvider for kind 'aws'", () => {
    const p = createInfraProvider({ kind: 'aws', awsRegion: 'us-east-1', cargoTomlPath: '/c' })
    expect(p).toBeInstanceOf(AwsInfraProvider)
  })
})

import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// NOTE: ESM mocking — `jest.mock` does NOT intercept static `import { spawn }
// from 'child_process'` under ts-jest/ESM (the binding is resolved before the
// mock applies, so the REAL spawn runs). Use `jest.unstable_mockModule` + a
// dynamic import of the SUT so the mocked core modules are in place first.
const spawnMock = jest.fn()
const mkdirSyncMock = jest.fn()
const writeFileSyncMock = jest.fn()
const rmSyncMock = jest.fn()
const openSyncMock = jest.fn(() => 7)
let metaStore: Record<string, string> = {}

jest.unstable_mockModule('child_process', () => ({ spawn: spawnMock }))
jest.unstable_mockModule('fs', () => ({
  mkdirSync: mkdirSyncMock,
  writeFileSync: (p: string, data: string) => {
    writeFileSyncMock(p, data)
    metaStore[p] = data
  },
  readFileSync: (p: string) => metaStore[p],
  existsSync: (p: string) => p in metaStore,
  rmSync: rmSyncMock,
  openSync: openSyncMock,
}))
jest.unstable_mockModule('net', () => ({
  createServer: () => {
    const handlers: Record<string, () => void> = {}
    return {
      once: (ev: string, cb: () => void) => {
        handlers[ev] = cb
      },
      listen: () => {
        setImmediate(() => handlers['listening']?.())
      },
      close: (cb: () => void) => cb(),
    }
  },
}))

const { LocalProcessInfraProvider } = await import('../local')
type LocalProviderConfig = import('../types').LocalProviderConfig

const cfg: LocalProviderConfig = {
  kind: 'local',
  runnerBin: '/tmp/boxlite-runner-backup',
  dyld: '/dyld',
  homeRoot: '/tmp/rop',
  portBase: 3100,
  insecureRegistries: '127.0.0.1:25000',
  terminateGraceSec: 1,
  apiUrl: 'http://localhost:3009/api',
  backupBucket: 'boxlite',
  backupEndpoint: 'http://127.0.0.1:29000',
  backupRegion: 'us-east-1',
  backupAccessKey: 'minioadmin',
  backupSecretKey: 'minioadmin',
}

beforeEach(() => {
  metaStore = {}
  spawnMock.mockReset().mockReturnValue({ pid: 4242, unref: jest.fn() })
  writeFileSyncMock.mockReset()
})

describe('LocalProcessInfraProvider', () => {
  it('provisionRunner spawns detached with backup env + writes meta', async () => {
    const p = new LocalProcessInfraProvider(cfg)
    const r = await p.provisionRunner({ runnerId: 'r1', apiKey: 'tok', apiUrl: 'http://localhost:3009/api', regionId: 'us' })
    expect(r.endpoint).toBe('http://127.0.0.1:3100')
    const [bin, , opts] = spawnMock.mock.calls[0] as any[]
    expect(bin).toBe('/tmp/boxlite-runner-backup')
    expect(opts.detached).toBe(true)
    expect(opts.env.BOXLITE_HOME_DIR).toBe('/tmp/rop/r1')
    expect(opts.env.BOXLITE_RUNNER_TOKEN).toBe('tok')
    expect(opts.env.BOXLITE_BACKUPS_BUCKET).toBe('boxlite')
    expect(opts.env.AWS_ACCESS_KEY_ID).toBe('minioadmin')
    expect(metaStore['/tmp/rop/r1/meta.json']).toContain('"pid": 4242')
  })

  it('uses a 12-char runnerId prefix for the home dir (macOS SUN_LEN budget)', async () => {
    const p = new LocalProcessInfraProvider(cfg)
    const longId = '074464f0-4753-4c34-9252-e1bdca2716fb' // 36-char UUID
    await p.provisionRunner({ runnerId: longId, apiKey: 'k', apiUrl: 'http://localhost:3009', regionId: 'us' })
    // meta.json is written under the home dir — its path reveals the dir name.
    const metaPath = writeFileSyncMock.mock.calls[0][0] as string
    expect(metaPath).toBe('/tmp/rop/074464f0-475/meta.json')
    expect(metaPath).not.toContain(longId) // full UUID would overflow the socket path
  })

  it('appends /api to BOXLITE_API_URL when the base lacks it (and is idempotent)', async () => {
    const p = new LocalProcessInfraProvider(cfg)
    // base WITHOUT /api → runner env must gain it
    await p.provisionRunner({ runnerId: 'rn', apiKey: 'k', apiUrl: 'http://localhost:3009', regionId: 'us' })
    expect((spawnMock.mock.calls[0][2] as any).env.BOXLITE_API_URL).toBe('http://localhost:3009/api')
    // base WITH /api (and trailing slash) → unchanged, no double suffix
    await p.provisionRunner({ runnerId: 'rs', apiKey: 'k', apiUrl: 'http://localhost:3009/api/', regionId: 'us' })
    expect((spawnMock.mock.calls[1][2] as any).env.BOXLITE_API_URL).toBe('http://localhost:3009/api')
  })

  it('describeRunner reports alive based on pid', async () => {
    const p = new LocalProcessInfraProvider(cfg)
    await p.provisionRunner({ runnerId: 'r2', apiKey: 'k', apiUrl: 'a', regionId: 'us' })
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as any)
    expect((await p.describeRunner('r2')).alive).toBe(true)
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH')
    })
    expect((await p.describeRunner('r2')).alive).toBe(false)
    killSpy.mockRestore()
  })

  it('terminateRunner kills pid + removes home', async () => {
    const p = new LocalProcessInfraProvider(cfg)
    await p.provisionRunner({ runnerId: 'r3', apiKey: 'k', apiUrl: 'a', regionId: 'us' })
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 0) throw new Error('gone')
      return true as any
    })
    await p.terminateRunner('r3')
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/rop/r3', expect.objectContaining({ recursive: true }))
    killSpy.mockRestore()
  })
})

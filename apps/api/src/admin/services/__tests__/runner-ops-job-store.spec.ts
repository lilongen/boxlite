import { Test } from '@nestjs/testing'
import { getRedisToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis-mock'
import { RunnerOpsJobStore } from '../runner-ops-job-store'

describe('RunnerOpsJobStore', () => {
  let store: RunnerOpsJobStore
  let redis: any

  beforeEach(async () => {
    redis = new Redis()
    const mod = await Test.createTestingModule({
      providers: [
        RunnerOpsJobStore,
        { provide: getRedisToken('default'), useValue: redis },
      ],
    }).compile()
    store = mod.get(RunnerOpsJobStore)
  })

  afterEach(async () => {
    await redis.flushall()
  })

  it('creates, appends, and reads a job', async () => {
    await store.create({
      id: 'j1',
      kind: 'add-shared',
      startedAt: new Date().toISOString(),
    })
    await store.appendLine('j1', 'line 1')
    await store.appendLine('j1', 'line 2')
    const job = await store.get('j1')
    expect(job?.lines).toEqual(['line 1', 'line 2'])
    expect(job?.status).toBe('RUNNING')
  })

  it('caps lines at 1000', async () => {
    await store.create({
      id: 'j2',
      kind: 'add-shared',
      startedAt: new Date().toISOString(),
    })
    for (let i = 0; i < 1500; i++) await store.appendLine('j2', `l${i}`)
    const job = await store.get('j2')
    expect(job?.lines.length).toBe(1000)
    expect(job?.lines[0]).toBe('l500')
  })

  it('finalizes with SUCCESS and result', async () => {
    await store.create({
      id: 'j3',
      kind: 'add-shared',
      startedAt: new Date().toISOString(),
    })
    await store.complete('j3', { runnerId: 'r1' })
    const job = await store.get('j3')
    expect(job?.status).toBe('SUCCESS')
    expect(job?.result).toEqual({ runnerId: 'r1' })
    expect(job?.finishedAt).toBeTruthy()
  })

  it('finalizes with FAILED on error', async () => {
    await store.create({
      id: 'j4',
      kind: 'scale-down',
      startedAt: new Date().toISOString(),
    })
    await store.fail('j4', 'boom', 5)
    const job = await store.get('j4')
    expect(job?.status).toBe('FAILED')
    expect(job?.error).toEqual({ message: 'boom', stage: 5 })
  })

  it('returns null for missing job', async () => {
    expect(await store.get('nope')).toBeNull()
  })

  it('acquires lock once and rejects second acquisition', async () => {
    const a = await store.tryAcquireLock('add-shared', 'j1', 60)
    const b = await store.tryAcquireLock('add-shared', 'j2', 60)
    expect(a).toBe(true)
    expect(b).toBe(false)
    await store.releaseLock('add-shared', 'j1')
    const c = await store.tryAcquireLock('add-shared', 'j2', 60)
    expect(c).toBe(true)
  })

  it('release is a no-op when current holder differs', async () => {
    await store.tryAcquireLock('scale-down', 'jA', 60)
    await store.releaseLock('scale-down', 'jB') // different holder
    const blocked = await store.tryAcquireLock('scale-down', 'jC', 60)
    expect(blocked).toBe(false)
  })
})

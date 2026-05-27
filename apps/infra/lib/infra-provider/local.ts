// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
//
// LocalProcessInfraProvider — spawns a native boxlite-runner process as the
// "runner host" (no Lima/EC2). The handle is the home dir named by runnerId:
// <homeRoot>/<runnerId>/. provisionRunner detach-spawns the runner and records
// {pid,port} in <home>/meta.json; terminate reads it, kills the pid, removes
// the home; describe checks the pid. Survives API restart (state on disk).

import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, openSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createServer } from 'net'
import type {
  IInfraProvider,
  RunnerHostSpec,
  ProvisionResult,
  DescribeResult,
  LocalProviderConfig,
} from './types.js'

interface RunnerMeta {
  runnerId: string
  pid: number
  port: number
  startedAt: string
}

export class LocalProcessInfraProvider implements IInfraProvider {
  constructor(private readonly cfg: LocalProviderConfig) {}

  private homeRoot(): string {
    return this.cfg.homeRoot.replace(/^~(?=$|\/)/, homedir())
  }
  private home(runnerId: string): string {
    return join(this.homeRoot(), runnerId)
  }
  private metaPath(runnerId: string): string {
    return join(this.home(runnerId), 'meta.json')
  }

  async provisionRunner(spec: RunnerHostSpec): Promise<ProvisionResult> {
    const home = this.home(spec.runnerId)
    mkdirSync(home, { recursive: true })
    const port = await this.pickFreePort()
    const logFd = openSync(join(home, 'runner.log'), 'a')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BOXLITE_HOME_DIR: home,
      API_PORT: String(port),
      API_VERSION: '2',
      RUNNER_DOMAIN: '127.0.0.1',
      BOXLITE_RUNNER_TOKEN: spec.apiKey,
      BOXLITE_API_URL: spec.apiUrl,
      INSECURE_REGISTRIES: this.cfg.insecureRegistries,
      AWS_REGION: this.cfg.backupRegion,
      BOXLITE_BACKUPS_BUCKET: this.cfg.backupBucket,
      BOXLITE_BACKUPS_ENDPOINT: this.cfg.backupEndpoint,
      BOXLITE_BACKUPS_REGION: this.cfg.backupRegion,
      AWS_ACCESS_KEY_ID: this.cfg.backupAccessKey,
      AWS_SECRET_ACCESS_KEY: this.cfg.backupSecretKey,
      ...(this.cfg.dyld ? { DYLD_LIBRARY_PATH: this.cfg.dyld } : {}),
    }
    const child = spawn(this.cfg.runnerBin, [], { detached: true, stdio: ['ignore', logFd, logFd], env })
    child.unref()
    if (!child.pid) throw new Error(`failed to spawn runner ${this.cfg.runnerBin}`)
    const meta: RunnerMeta = { runnerId: spec.runnerId, pid: child.pid, port, startedAt: new Date().toISOString() }
    writeFileSync(this.metaPath(spec.runnerId), JSON.stringify(meta, null, 2))
    return { endpoint: `http://127.0.0.1:${port}` }
  }

  async terminateRunner(runnerId: string): Promise<void> {
    const meta = this.readMeta(runnerId)
    if (!meta) return
    try {
      process.kill(meta.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + this.cfg.terminateGraceSec * 1000
    while (Date.now() < deadline) {
      if (!this.pidAlive(meta.pid)) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (this.pidAlive(meta.pid)) {
      try {
        process.kill(meta.pid, 'SIGKILL')
      } catch {
        /* race: exited between check and kill */
      }
    }
    rmSync(this.home(runnerId), { recursive: true, force: true })
  }

  async describeRunner(runnerId: string): Promise<DescribeResult> {
    const meta = this.readMeta(runnerId)
    return { alive: !!meta && this.pidAlive(meta.pid) }
  }

  private readMeta(runnerId: string): RunnerMeta | null {
    const p = this.metaPath(runnerId)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as RunnerMeta
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async pickFreePort(): Promise<number> {
    const base = this.cfg.portBase
    const tryPort = (port: number): Promise<boolean> =>
      new Promise((res) => {
        const srv = createServer()
        srv.once('error', () => res(false))
        srv.once('listening', () => srv.close(() => res(true)))
        srv.listen(port, '127.0.0.1')
      })
    for (let p = base; p < base + 200; p++) {
      if (await tryPort(p)) return p
    }
    throw new Error(`No free port near ${base}`)
  }
}

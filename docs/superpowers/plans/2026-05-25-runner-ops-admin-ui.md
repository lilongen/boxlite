# Runner Ops Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an admin-only dashboard page that lists SHARED runners and triggers add/scale-down operations by calling the already-validated `apps/infra/scripts/*` orchestration logic as in-process libraries — no auto-scaling, no shell-out, no SSE.

**Architecture:** Refactor the two existing operator CLI scripts into `async function*` generator libraries (`apps/infra/lib/`). A new NestJS service consumes the generator, persists progress to a Redis-backed job store, and exposes admin REST endpoints under `/admin/runner-ops/*`. A new React page (`/dashboard/admin/runner-ops`) polls the job store every 2 s. Platform-admin gating is added by exposing `SystemRole` on `UserDto` and introducing a `<RequireAdmin>` route guard.

**Tech Stack:** NestJS, TypeORM, ioredis (`@nestjs-modules/ioredis`), AWS SDK v3 (`@aws-sdk/client-ec2`), Jest (api unit/integration), React + react-router-dom, `@boxlite-ai/api-client` (auto-generated from OpenAPI).

**Spec:** `docs/superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md`

**Pre-flight checks (run once before Task 1):**

```bash
cd /Users/lilongen/github/boxlite-cloud-mvp-runner-auto-scaling
git status                                              # must be clean or with this plan only
git log --oneline -1                                    # confirm branch HEAD
cd apps && yarn install --frozen-lockfile               # warm node_modules
cd apps && ./node_modules/.bin/tsc -p api/tsconfig.app.json --noEmit  # baseline: must be 0 errors
```

If `tsc` reports errors, stop and fix Foundation gaps first.

---

## File Structure

### New files

| Path | Purpose |
| --- | --- |
| `apps/infra/lib/runner-ops-types.ts` | `ProgressEvent`, `*Opts`, `*Result` types shared by libs + service |
| `apps/infra/lib/add-shared-runner-lib.ts` | `async function* addSharedRunner(opts)` — extracted from `scripts/add-shared-runner.ts` |
| `apps/infra/lib/scale-down-runner-lib.ts` | `async function* scaleDownRunner(opts)` — extracted from `scripts/scale-down-runner.ts` |
| `apps/api/src/admin/dto/runner-ops.dto.ts` | Request + response DTOs |
| `apps/api/src/admin/services/runner-ops-job-store.ts` | Redis CRUD for job records |
| `apps/api/src/admin/services/runner-ops.service.ts` | Orchestrates lib calls + job lifecycle + Redis lock |
| `apps/api/src/admin/services/__tests__/runner-ops-job-store.spec.ts` | Job store unit tests |
| `apps/api/src/admin/services/__tests__/runner-ops.service.spec.ts` | Service unit tests with mocked lib generator |
| `apps/api/src/admin/controllers/runner-ops.controller.ts` | Five admin endpoints |
| `apps/api/src/admin/controllers/__tests__/runner-ops.controller.spec.ts` | Controller integration test (auth + lifecycle) |
| `apps/dashboard/src/hooks/useCurrentUser.ts` | Loads `/users/me` and exposes `isPlatformAdmin` |
| `apps/dashboard/src/components/auth/RequireAdmin.tsx` | Route guard redirecting non-admins |
| `apps/dashboard/src/hooks/useRunnerOpsJob.ts` | 2 s polling hook with unmount cancellation |
| `apps/dashboard/src/components/admin/RunnerOpsTable.tsx` | Table of SHARED runners with per-row actions |
| `apps/dashboard/src/components/admin/AddSharedRunnerDialog.tsx` | Form + submit + poll |
| `apps/dashboard/src/components/admin/ScaleDownDialog.tsx` | Confirm + poll + stage display |
| `apps/dashboard/src/pages/admin/RunnerOps.tsx` | Page wiring (header + table + dialogs) |
| `docs/runner-scaling/runner-ops-ui-runbook.md` | English operator runbook |

### Modified files

| Path | Change |
| --- | --- |
| `apps/api/src/user/dto/user.dto.ts` | Add `role: SystemRole` to DTO and `fromUser()` |
| `apps/api/src/sandbox/services/runner.service.ts` | Add optional `regionType` filter to `findAllFull()` |
| `apps/api/src/admin/admin.module.ts` | Register new controller + service |
| `apps/infra/scripts/add-shared-runner.ts` | Reduce to argv → lib → stderr/exit shell |
| `apps/infra/scripts/scale-down-runner.ts` | Same shell shape |
| `apps/dashboard/src/enums/RoutePath.ts` | Add `ADMIN_RUNNER_OPS` |
| `apps/dashboard/src/App.tsx` | Add `<Route>` wrapped in `<RequireAdmin>` |
| Dashboard sidebar (locate via `grep "RoutePath.SANDBOXES"`) | Conditional "Runner Ops" entry |
| `docs/runner-scaling/README.md` | Index pointer to new runbook + spec |

### Regenerated artifacts (no manual edit)

- `libs/api-client-ts/**` — regenerated twice: once after Task 1, once after Task 11.

---

## Conventions

- **Commits:** conventional commit style matching recent history. Prefix `feat`, `fix`, `refactor`, `test`, `docs`, `chore`; scope in parens (e.g. `feat(admin): runner ops endpoints`).
- **Co-author trailer:** none requested by user; omit unless the operator wants one.
- **Tests:** every code-changing task has at least one failing test written first.
- **Commit cadence:** one commit per task at minimum; intermediate commits encouraged.
- **Type imports:** prefer `import type {...}` for type-only imports.
- **Pino logging in apps/api:** use `Logger` from `@nestjs/common`, follow existing pattern (`new Logger(ClassName.name)`).

---

## Task 1: Expose `SystemRole` on `UserDto` (prereq P1 + P2)

**Files:**
- Modify: `apps/api/src/user/dto/user.dto.ts`
- Test: search for existing `user.dto.spec.ts` or add new one at `apps/api/src/user/dto/__tests__/user.dto.spec.ts`

- [ ] **Step 1: Confirm no existing test for `UserDto.fromUser`**

```bash
find apps/api/src/user -name '*.spec.ts' 2>/dev/null
```

If none, we create one in Step 2. If one exists, append the new test inside it.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/user/dto/__tests__/user.dto.spec.ts`:

```typescript
import { User } from '../../user.entity'
import { SystemRole } from '../../enums/system-role.enum'
import { UserDto } from '../user.dto'

describe('UserDto.fromUser', () => {
  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: 'u-1',
      name: 'Operator',
      email: 'op@example.com',
      role: SystemRole.ADMIN,
      publicKeys: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    } as User
  }

  it('exposes role for admin users', () => {
    const dto = UserDto.fromUser(makeUser({ role: SystemRole.ADMIN }))
    expect(dto.role).toBe(SystemRole.ADMIN)
  })

  it('exposes role for plain users', () => {
    const dto = UserDto.fromUser(makeUser({ role: SystemRole.USER }))
    expect(dto.role).toBe(SystemRole.USER)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd apps && yarn nx test api --testPathPattern user.dto.spec --runInBand
```

Expected: FAIL — `dto.role` is `undefined`.

- [ ] **Step 4: Implement `role` on `UserDto`**

In `apps/api/src/user/dto/user.dto.ts`, add the import and field:

```typescript
import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { User } from '../user.entity'
import { UserPublicKeyDto } from './user-public-key.dto'
import { SystemRole } from '../enums/system-role.enum'

@ApiSchema({ name: 'User' })
export class UserDto {
  @ApiProperty({ description: 'User ID' })
  id: string

  @ApiProperty({ description: 'User name' })
  name: string

  @ApiProperty({ description: 'User email' })
  email: string

  @ApiProperty({ description: 'System role', enum: SystemRole, enumName: 'SystemRole' })
  role: SystemRole

  @ApiProperty({ description: 'User public keys', type: [UserPublicKeyDto] })
  publicKeys: UserPublicKeyDto[]

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date

  static fromUser(user: User): UserDto {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      publicKeys: user.publicKeys.map(UserPublicKeyDto.fromUserPublicKey),
      createdAt: user.createdAt,
    }
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd apps && yarn nx test api --testPathPattern user.dto.spec --runInBand
```

Expected: PASS, two tests.

- [ ] **Step 6: Regenerate the api-client**

Discover the generator target by inspecting `libs/api-client-ts/project.json` (search for an `openapi` or `generate` target). Most likely:

```bash
cd apps && yarn nx run api-client-ts:generate
```

If that target name differs, run `yarn nx show project api-client-ts` and use the listed target.

- [ ] **Step 7: Verify the regenerated `User` type carries `role`**

```bash
grep -n "role" libs/api-client-ts/src/models/User.ts 2>/dev/null \
  || grep -rn "role" libs/api-client-ts/src/models/ | head -5
```

Expected: a `role: SystemRole;` line (or `role?: SystemRole;` depending on optionality).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/user/dto/user.dto.ts \
        apps/api/src/user/dto/__tests__/user.dto.spec.ts \
        libs/api-client-ts/
git commit -m "feat(api): expose SystemRole on UserDto so dashboard can gate admin"
```

---

## Task 2: Dashboard admin role infrastructure (prereq P3a + P3b)

**Files:**
- Create: `apps/dashboard/src/hooks/useCurrentUser.ts`
- Create: `apps/dashboard/src/components/auth/RequireAdmin.tsx`
- Modify: `apps/dashboard/src/enums/RoutePath.ts`

- [ ] **Step 1: Discover whether `/users/me` is already fetched somewhere**

```bash
grep -rn "getAuthenticatedUser\|usersApi\|/users/me" apps/dashboard/src 2>/dev/null \
  | grep -v node_modules | head -20
```

If a context or hook already loads it, extend that source. If not (likely), proceed with a new hook below.

- [ ] **Step 2: Write the failing test for `useCurrentUser`**

Create `apps/dashboard/src/hooks/__tests__/useCurrentUser.test.tsx`. (Confirm vitest + RTL setup with `find apps/dashboard -name "vitest.config*"`; if absent, fall through to Step 6 and add the test once setup exists — but typically dashboard has vitest configured.)

```typescript
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { SystemRole } from '@boxlite-ai/api-client'
import { ApiContext } from '@/contexts/ApiContext'
import { useCurrentUser } from '../useCurrentUser'
import React from 'react'

function withApi(getAuthenticatedUser: () => Promise<unknown>) {
  const value = { usersApi: { getAuthenticatedUser } } as any
  return ({ children }: { children: React.ReactNode }) => (
    <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
  )
}

describe('useCurrentUser', () => {
  it('reports isPlatformAdmin=true when role is ADMIN', async () => {
    const fn = vi.fn().mockResolvedValue({ data: { id: 'u', name: 'a', email: 'a@b', role: SystemRole.ADMIN } })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: withApi(fn) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isPlatformAdmin).toBe(true)
  })

  it('reports isPlatformAdmin=false when role is USER', async () => {
    const fn = vi.fn().mockResolvedValue({ data: { id: 'u', name: 'a', email: 'a@b', role: SystemRole.USER } })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: withApi(fn) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isPlatformAdmin).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd apps && yarn nx test dashboard --testPathPattern useCurrentUser
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `useCurrentUser` hook**

Create `apps/dashboard/src/hooks/useCurrentUser.ts`:

```typescript
import { useEffect, useState } from 'react'
import { User, SystemRole } from '@boxlite-ai/api-client'
import { useApi } from './useApi'

export interface CurrentUserState {
  user: User | null
  loading: boolean
  isPlatformAdmin: boolean
  error: Error | null
  refetch: () => Promise<void>
}

export function useCurrentUser(): CurrentUserState {
  const { usersApi } = useApi()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchUser = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await usersApi.getAuthenticatedUser()
      setUser(response.data ?? null)
    } catch (e) {
      setError(e as Error)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUser()
    // intentional one-shot on mount; consumers can call refetch on demand
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const isPlatformAdmin = user?.role === SystemRole.ADMIN

  return { user, loading, isPlatformAdmin, error, refetch: fetchUser }
}
```

If `useApi` doesn't expose `usersApi`, look in `apps/dashboard/src/contexts/ApiContext.tsx`, locate the construction of api clients, and add `usersApi: new UsersApi(...)` next to the existing `runnersApi`. Mirror its initialization. Commit that change as part of this task.

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd apps && yarn nx test dashboard --testPathPattern useCurrentUser
```

Expected: PASS, two tests.

- [ ] **Step 6: Add `RoutePath.ADMIN_RUNNER_OPS`**

In `apps/dashboard/src/enums/RoutePath.ts`, add the constant (placement alphabetical near existing `/dashboard/*` paths):

```typescript
ADMIN_RUNNER_OPS = '/dashboard/admin/runner-ops',
```

- [ ] **Step 7: Write the failing test for `RequireAdmin`**

Create `apps/dashboard/src/components/auth/__tests__/RequireAdmin.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { RequireAdmin } from '../RequireAdmin'

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(),
}))
import { useCurrentUser } from '@/hooks/useCurrentUser'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin" element={<RequireAdmin><div>admin-content</div></RequireAdmin>} />
        <Route path="/dashboard/sandboxes" element={<div>sandboxes-page</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('RequireAdmin', () => {
  it('renders children when user is platform admin', () => {
    ;(useCurrentUser as any).mockReturnValue({ user: { role: 'admin' }, loading: false, isPlatformAdmin: true })
    renderAt('/admin')
    expect(screen.getByText('admin-content')).toBeInTheDocument()
  })

  it('redirects non-admin users to sandboxes', () => {
    ;(useCurrentUser as any).mockReturnValue({ user: { role: 'user' }, loading: false, isPlatformAdmin: false })
    renderAt('/admin')
    expect(screen.getByText('sandboxes-page')).toBeInTheDocument()
  })

  it('renders a spinner while loading', () => {
    ;(useCurrentUser as any).mockReturnValue({ user: null, loading: true, isPlatformAdmin: false })
    renderAt('/admin')
    expect(screen.queryByText('admin-content')).toBeNull()
  })
})
```

- [ ] **Step 8: Run the test and confirm it fails**

```bash
cd apps && yarn nx test dashboard --testPathPattern RequireAdmin
```

Expected: FAIL — module not found.

- [ ] **Step 9: Implement `RequireAdmin`**

Create `apps/dashboard/src/components/auth/RequireAdmin.tsx`:

```typescript
import React, { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { RoutePath } from '@/enums/RoutePath'

interface RequireAdminProps {
  children: ReactNode
}

export const RequireAdmin: React.FC<RequireAdminProps> = ({ children }) => {
  const { loading, isPlatformAdmin } = useCurrentUser()
  if (loading) {
    return <div role="status" aria-label="loading">Loading…</div>
  }
  if (!isPlatformAdmin) {
    return <Navigate to={RoutePath.SANDBOXES} replace />
  }
  return <>{children}</>
}
```

- [ ] **Step 10: Run the test and confirm it passes**

```bash
cd apps && yarn nx test dashboard --testPathPattern RequireAdmin
```

Expected: PASS, three tests.

- [ ] **Step 11: Commit**

```bash
git add apps/dashboard/src/hooks/useCurrentUser.ts \
        apps/dashboard/src/hooks/__tests__/useCurrentUser.test.tsx \
        apps/dashboard/src/components/auth/RequireAdmin.tsx \
        apps/dashboard/src/components/auth/__tests__/RequireAdmin.test.tsx \
        apps/dashboard/src/enums/RoutePath.ts \
        apps/dashboard/src/contexts/ApiContext.tsx
git commit -m "feat(dashboard): platform-admin role hook + route guard"
```

(Include `ApiContext.tsx` in the commit only if it was modified to add `usersApi`.)

---

## Task 3: Lib shared types

**Files:**
- Create: `apps/infra/lib/runner-ops-types.ts`

- [ ] **Step 1: Create the directory + file**

```bash
mkdir -p apps/infra/lib
```

Create `apps/infra/lib/runner-ops-types.ts`:

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
//
// Shared types between add-shared-runner-lib and scale-down-runner-lib,
// the CLI shells under apps/infra/scripts/, and the NestJS service that
// consumes the libs from apps/api.

export type ProgressEvent =
  | { type: 'stage'; stage: number; total: number; label: string }
  | { type: 'log'; line: string }
  | { type: 'data'; key: string; value: unknown }
  | { type: 'warning'; line: string }

export interface AddSharedRunnerOpts {
  apiUrl: string
  adminToken: string
  awsRegion: string
  name?: string
  regionId?: string
  instanceType?: string
  diskGb?: number
  withBackupSidecar?: boolean
  registryUrl?: string
  subnetId?: string
  instanceProfileName?: string
  timeoutSec?: number
  noWait?: boolean
  signal?: AbortSignal
}

export interface AddSharedRunnerResult {
  runnerId: string
  runnerName: string
  apiKey: string
  ec2InstanceId: string
  privateIp?: string
  finalState: 'READY' | 'INITIALIZING' | 'TIMEOUT'
}

export interface ScaleDownOpts {
  apiUrl: string
  adminToken: string
  awsRegion: string
  runnerId: string
  restartStopped?: boolean
  skipEc2Terminate?: boolean
  dryRun?: boolean
  maxWaitBackupSec?: number
  maxWaitStopSec?: number
  maxWaitArchiveSec?: number
  maxWaitStartSec?: number
  signal?: AbortSignal
}

export interface ScaleDownResult {
  runnerId: string
  sandboxesMigrated: string[]
  sandboxesArchived: string[]
  ec2InstancesTerminated: string[]
  durationMs: number
}

export class OperationAbortedError extends Error {
  constructor(message = 'operation aborted by caller') {
    super(message)
    this.name = 'OperationAbortedError'
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/infra && npx tsc --noEmit lib/runner-ops-types.ts
```

Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add apps/infra/lib/runner-ops-types.ts
git commit -m "feat(infra): shared types for runner-ops libs"
```

---

## Task 4: Extract `addSharedRunner` lib + reduce CLI to shell

**Files:**
- Create: `apps/infra/lib/add-shared-runner-lib.ts`
- Modify (heavy): `apps/infra/scripts/add-shared-runner.ts`
- Create: `apps/infra/scripts/__tests__/add-shared-runner-cli.snapshot.test.ts` (lightweight golden test)

**Approach:** the script's `main()` (line 505 in current file) contains all the orchestration. Move it verbatim into the lib, replacing `process.stderr.write(...)` calls with `yield { type: 'log', ... }` and stage-banner writes with `yield { type: 'stage', ... }`. The script becomes a thin loop over the generator.

- [ ] **Step 1: Read the existing `main()` body to map yield points**

```bash
sed -n '505,680p' apps/infra/scripts/add-shared-runner.ts
```

Identify every `process.stderr.write` and `result.flush`. Number the stages 1..N where the script currently prints `[k/7]` banners.

- [ ] **Step 2: Write the failing lib test**

Create `apps/infra/lib/__tests__/add-shared-runner-lib.test.ts`. First, confirm jest works in `apps/infra`:

```bash
cd apps/infra && ls jest.config.* 2>/dev/null
```

If absent, add a minimal config at `apps/infra/jest.config.cjs`:

```javascript
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true }] },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testMatch: ['<rootDir>/lib/**/*.test.ts', '<rootDir>/scripts/**/*.test.ts'],
}
```

Then the test:

```typescript
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
    // expose send for assertions
    __send: send,
  }
})

const ec2 = jest.requireMock('@aws-sdk/client-ec2') as any

beforeEach(() => {
  mockFetch.mockReset()
  ec2.__send.mockReset()
})

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response
}

describe('addSharedRunner generator', () => {
  it('yields stage events and returns a result on the happy path', async () => {
    // Sequence: probeAdminAuth → createSharedRunner → resolveUbuntuAmi → RunInstances → pollUntilReady
    mockFetch
      .mockResolvedValueOnce(okResponse({ id: 'u-1', role: 'admin' }))      // /users/me probe
      .mockResolvedValueOnce(okResponse({ id: 'r-1', name: 'r' }))            // POST /admin/runners
      .mockResolvedValueOnce(okResponse({ id: 'r-1', state: 'ready' }))       // GET /admin/runners/r-1 (poll)
    ec2.__send
      .mockResolvedValueOnce({ Images: [{ ImageId: 'ami-test', CreationDate: '2026-01-01' }] }) // DescribeImages
      .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-test', PrivateIpAddress: '10.0.0.1' }] }) // RunInstances

    const opts: AddSharedRunnerOpts = {
      apiUrl: 'http://api.example',
      adminToken: 'tok',
      awsRegion: 'ap-southeast-1',
      name: 'runner-test',
      subnetId: 'subnet-test',
      instanceProfileName: 'profile-test',
      registryUrl: 'http://registry.example',
      timeoutSec: 60,
    }

    const events: ProgressEvent[] = []
    const gen = addSharedRunner(opts)
    let result
    while (true) {
      const next = await gen.next()
      if (next.done) { result = next.value; break }
      events.push(next.value)
    }
    expect(result?.runnerId).toBe('r-1')
    expect(result?.ec2InstanceId).toBe('i-test')
    expect(events.some((e) => e.type === 'stage' && e.stage === 1)).toBe(true)
    // apiKey must not appear in log events
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as any).line).join('\n')
    expect(logs).not.toMatch(/[A-Za-z0-9_-]{40,}/)
  })

  it('throws OperationAbortedError when signal is aborted before first yield', async () => {
    const controller = new AbortController()
    controller.abort()
    const gen = addSharedRunner({
      apiUrl: 'http://api.example',
      adminToken: 'tok',
      awsRegion: 'ap-southeast-1',
      signal: controller.signal,
    })
    await expect(gen.next()).rejects.toThrow('aborted')
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd apps/infra && npx jest add-shared-runner-lib --runInBand
```

Expected: FAIL — `addSharedRunner` not exported.

- [ ] **Step 4: Implement `addSharedRunner` lib**

Create `apps/infra/lib/add-shared-runner-lib.ts`. The skeleton:

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import * as crypto from 'crypto'
import {
  EC2Client,
  RunInstancesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2'
import type {
  AddSharedRunnerOpts,
  AddSharedRunnerResult,
  ProgressEvent,
} from './runner-ops-types'
import { OperationAbortedError } from './runner-ops-types'

const UBUNTU_OWNER_ID = '099720109477'
const UBUNTU_NAME_PATTERN = 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'
export const RUNNER_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationAbortedError()
}

function generateRunnerApiKey(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function defaultName(): string {
  return `runner-shared-${crypto.randomBytes(3).toString('hex')}`
}

class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, method: string, path: string) {
    super(`API ${method} ${path} → ${status}: ${body.slice(0, 500)}`)
  }
}

async function apiFetch<T>(
  baseUrl: string,
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${apiPath}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new ApiError(res.status, text, method, apiPath)
  return (text ? JSON.parse(text) : ({} as T)) as T
}

export async function* addSharedRunner(
  opts: AddSharedRunnerOpts,
): AsyncGenerator<ProgressEvent, AddSharedRunnerResult, void> {
  checkAborted(opts.signal)

  // ─── Stage 1: validate args ────────────────────────────────────────
  yield { type: 'stage', stage: 1, total: 7, label: 'validate inputs' }
  const name = opts.name ?? defaultName()
  if (!RUNNER_NAME_REGEX.test(name)) {
    throw new Error(`invalid runner name: ${name}`)
  }
  const regionId = opts.regionId ?? 'us'
  const instanceType = (opts.instanceType ?? 'c8i.2xlarge') as _InstanceType
  const diskGb = opts.diskGb ?? 100

  // ─── Stage 2: probe admin auth ─────────────────────────────────────
  yield { type: 'stage', stage: 2, total: 7, label: 'probe admin auth' }
  checkAborted(opts.signal)
  const me = await apiFetch<{ id: string; role: string }>(opts.apiUrl, opts.adminToken, 'GET', '/v1/users/me')
  if (me.role !== 'admin') throw new Error(`token does not have admin role (got ${me.role})`)

  // ─── Stage 3: create runner row in apps/api ────────────────────────
  yield { type: 'stage', stage: 3, total: 7, label: 'create runner row' }
  checkAborted(opts.signal)
  const apiKey = generateRunnerApiKey()
  const created = await apiFetch<{ id: string; name: string }>(
    opts.apiUrl,
    opts.adminToken,
    'POST',
    '/v1/admin/runners',
    {
      name,
      regionId,
      cpu: 8, memoryGiB: 16, diskGiB: diskGb,
      apiKey,
    },
  )
  yield { type: 'data', key: 'apiKey', value: apiKey }       // out-of-band
  yield { type: 'data', key: 'runnerId', value: created.id } // out-of-band
  yield { type: 'log', line: `created runner row id=${created.id} name=${created.name}` }

  // ─── Stage 4: resolve AMI ──────────────────────────────────────────
  yield { type: 'stage', stage: 4, total: 7, label: 'resolve Ubuntu AMI' }
  checkAborted(opts.signal)
  const ec2 = new EC2Client({ region: opts.awsRegion })
  const images = await ec2.send(
    new DescribeImagesCommand({
      Owners: [UBUNTU_OWNER_ID],
      Filters: [{ Name: 'name', Values: [UBUNTU_NAME_PATTERN] }],
    }),
  )
  const ami = (images.Images ?? [])
    .filter((i) => i.ImageId && i.CreationDate)
    .sort((a, b) => (a.CreationDate! < b.CreationDate! ? 1 : -1))[0]
  if (!ami?.ImageId) throw new Error('no Ubuntu AMI found')
  yield { type: 'log', line: `resolved AMI ${ami.ImageId}` }

  // ─── Stage 5: launch EC2 ───────────────────────────────────────────
  yield { type: 'stage', stage: 5, total: 7, label: 'launch EC2' }
  checkAborted(opts.signal)
  const userData = buildUserData({
    runnerId: created.id,
    apiKey,
    apiUrl: opts.apiUrl,
    registryUrl: opts.registryUrl,
    withBackupSidecar: opts.withBackupSidecar ?? false,
  })
  const launch = await ec2.send(
    new RunInstancesCommand({
      ImageId: ami.ImageId,
      InstanceType: instanceType,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: opts.subnetId,
      IamInstanceProfile: opts.instanceProfileName ? { Name: opts.instanceProfileName } : undefined,
      UserData: Buffer.from(userData).toString('base64'),
      BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: diskGb, VolumeType: 'gp3', DeleteOnTermination: true } }],
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Name', Value: name },
            { Key: 'RunnerId', Value: created.id },
            { Key: 'BoxliteRole', Value: 'runner-shared' },
          ],
        },
      ],
    }),
  )
  const inst = launch.Instances?.[0]
  if (!inst?.InstanceId) throw new Error('RunInstances returned no instance')
  yield { type: 'data', key: 'ec2InstanceId', value: inst.InstanceId }
  yield { type: 'log', line: `launched ec2 ${inst.InstanceId}` }

  // ─── Stage 6: write durable result (lib caller does this via 'data' events) ──
  yield { type: 'stage', stage: 6, total: 7, label: 'durable result written' }

  if (opts.noWait) {
    yield { type: 'log', line: 'noWait: skipping readiness poll' }
    return {
      runnerId: created.id,
      runnerName: created.name,
      apiKey,
      ec2InstanceId: inst.InstanceId,
      privateIp: inst.PrivateIpAddress ?? undefined,
      finalState: 'INITIALIZING',
    }
  }

  // ─── Stage 7: poll readiness ───────────────────────────────────────
  yield { type: 'stage', stage: 7, total: 7, label: 'poll runner readiness' }
  const deadline = Date.now() + (opts.timeoutSec ?? 600) * 1000
  let finalState: AddSharedRunnerResult['finalState'] = 'TIMEOUT'
  while (Date.now() < deadline) {
    checkAborted(opts.signal)
    const r = await apiFetch<{ state: string }>(
      opts.apiUrl, opts.adminToken, 'GET', `/v1/admin/runners/${created.id}`,
    )
    if (r.state === 'ready') { finalState = 'READY'; break }
    yield { type: 'log', line: `runner state=${r.state}, waiting…` }
    await new Promise((res) => setTimeout(res, 5000))
  }

  return {
    runnerId: created.id,
    runnerName: created.name,
    apiKey,
    ec2InstanceId: inst.InstanceId,
    privateIp: inst.PrivateIpAddress ?? undefined,
    finalState,
  }
}

function buildUserData(args: {
  runnerId: string
  apiKey: string
  apiUrl: string
  registryUrl?: string
  withBackupSidecar: boolean
}): string {
  // Re-use the existing builder from apps/infra/lib/runner-user-data.ts.
  // Import lazily to avoid pulling it at module load time when the lib is
  // consumed from apps/api (where the helper is fine but unused).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildRunnerUserData } = require('./runner-user-data')
  return buildRunnerUserData({
    runnerId: args.runnerId,
    apiKey: args.apiKey,
    apiUrl: args.apiUrl,
    registryUrl: args.registryUrl,
    withBackupSidecar: args.withBackupSidecar,
  })
}
```

**Important:** the existing `apps/infra/scripts/add-shared-runner.ts` contains logic beyond this skeleton (TTY confirm, redacted logging, result file). Those belong in the CLI shell, not in the lib. When porting line-by-line, move ONLY the orchestration; leave UX in the script.

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd apps/infra && npx jest add-shared-runner-lib --runInBand
```

Expected: PASS, two tests.

- [ ] **Step 6: Reduce `apps/infra/scripts/add-shared-runner.ts` to a CLI shell**

Replace the existing `main()` (line 505 onward) with a generator-driven shell. Preserve `parseArgs`, TTY confirm, redacted logging, and the result-file writer. New `main()`:

```typescript
async function main(): Promise<number> {
  const args = parseArgs()
  if (!args.yes && !(await confirmTty('Add a new shared runner? (y/N) '))) {
    return EXIT.REFUSED
  }
  const result = new ResultWriter(args.resultFile)
  try {
    let stage = 0
    for await (const ev of addSharedRunner({
      apiUrl: args.apiUrl,
      adminToken: args.adminToken,
      awsRegion: AWS_REGION,
      name: args.name,
      regionId: args.regionId,
      instanceType: args.instanceType,
      diskGb: args.diskGb,
      withBackupSidecar: args.withBackupSidecar,
      registryUrl: args.registryUrl,
      subnetId: args.subnetId,
      instanceProfileName: args.instanceProfileName,
      timeoutSec: args.timeout,
      noWait: args.noWait,
    })) {
      if (ev.type === 'stage') {
        stage = ev.stage
        process.stderr.write(`[${ev.stage}/${ev.total}] ${ev.label}\n`)
      } else if (ev.type === 'log') {
        process.stderr.write(`       ${ev.line}\n`)
      } else if (ev.type === 'warning') {
        process.stderr.write(`WARN: ${ev.line}\n`)
      } else if (ev.type === 'data') {
        if (ev.key === 'apiKey') {
          result.setApiKey(ev.value as string)
          process.stderr.write(`       apiKey=${redactApiKey(ev.value as string)} (full value written to ${args.resultFile})\n`)
        } else if (ev.key === 'runnerId') {
          result.setRunnerId(ev.value as string)
        } else if (ev.key === 'ec2InstanceId') {
          result.setEc2InstanceId(ev.value as string)
        }
        result.flush()
      }
    }
    result.setReady(args.apiUrl)
    result.flush()
    return EXIT.OK
  } catch (e: any) {
    process.stderr.write(`ERROR: ${e?.stack ?? e}\n`)
    if (e instanceof Error && e.message.includes('admin role')) return EXIT.API
    if (e instanceof Error && /RunInstances|AMI/.test(e.message)) return EXIT.EC2_LAUNCH
    return EXIT.PREFLIGHT
  }
}
```

Add the import at the top:

```typescript
import { addSharedRunner } from '../lib/add-shared-runner-lib'
```

Remove any duplicate code now living in the lib (apiFetch helpers, AMI resolution, EC2 launch, etc.). Keep `parseArgs`, `ResultWriter`, `confirmTty`, `redactApiKey`, and `validateRunnerName`.

- [ ] **Step 7: Manual CLI regression — confirm output matches pre-refactor for the dry run**

```bash
cd apps/infra && BOXLITE_ADMIN_API_KEY=dummy \
  npx tsx scripts/add-shared-runner.ts --help
```

Expected: argv help text identical to the prior version.

- [ ] **Step 8: Write a CLI snapshot test**

Create `apps/infra/scripts/__tests__/add-shared-runner-cli.snapshot.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals'
import { execSync } from 'child_process'

describe('add-shared-runner CLI', () => {
  it('--help output is stable', () => {
    const out = execSync('npx tsx scripts/add-shared-runner.ts --help', { encoding: 'utf-8', cwd: process.cwd() })
    expect(out).toMatchSnapshot()
  })
})
```

Run once to seed the snapshot:

```bash
cd apps/infra && npx jest add-shared-runner-cli.snapshot
```

Expected: snapshot written; subsequent runs PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/infra/lib/add-shared-runner-lib.ts \
        apps/infra/lib/__tests__/add-shared-runner-lib.test.ts \
        apps/infra/scripts/add-shared-runner.ts \
        apps/infra/scripts/__tests__/add-shared-runner-cli.snapshot.test.ts \
        apps/infra/scripts/__tests__/__snapshots__/ \
        apps/infra/jest.config.cjs
git commit -m "refactor(infra): extract addSharedRunner into reusable lib"
```

---

## Task 5: Extract `scaleDownRunner` lib + reduce CLI to shell

**Files:**
- Create: `apps/infra/lib/scale-down-runner-lib.ts`
- Modify (heavy): `apps/infra/scripts/scale-down-runner.ts`
- Create: `apps/infra/scripts/__tests__/scale-down-runner-cli.snapshot.test.ts`

**Approach:** identical to Task 4. The script's 10-stage orchestration moves into the lib as generator yields. The script becomes a thin loop.

- [ ] **Step 1: Read the existing `main()` body to map yield points**

```bash
sed -n '490,820p' apps/infra/scripts/scale-down-runner.ts
```

Map every `[k/10]` banner to a `yield { type: 'stage', stage: k, total: 10, label: ... }`.

- [ ] **Step 2: Write the failing lib test**

Create `apps/infra/lib/__tests__/scale-down-runner-lib.test.ts`:

```typescript
import { describe, it, expect, jest } from '@jest/globals'
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
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response
}

beforeEach(() => { mockFetch.mockReset(); ec2.__send.mockReset() })

describe('scaleDownRunner generator', () => {
  it('preflight fails when runner is not SHARED', async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ id: 'r-1', state: 'ready', regionType: 'custom', apiKey: 'k', currentStartedSandboxes: 0 }))

    const gen = scaleDownRunner({ apiUrl: 'http://api', adminToken: 't', awsRegion: 'ap-southeast-1', runnerId: 'r-1', dryRun: true })
    await expect(gen.next().then(() => gen.next())).rejects.toThrow(/SHARED/)
  })

  it('dry-run yields all preflight stages then returns', async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ id: 'r-1', state: 'ready', regionType: 'shared', apiKey: 'k', currentStartedSandboxes: 0, region: 'us' }))
      .mockResolvedValueOnce(okResponse([{ id: 'r-2', state: 'ready', regionType: 'shared', region: 'us' }, { id: 'r-1', state: 'ready', regionType: 'shared', region: 'us' }]))
      .mockResolvedValueOnce(okResponse([])) // empty sandbox list

    const events: ProgressEvent[] = []
    const gen = scaleDownRunner({ apiUrl: 'http://api', adminToken: 't', awsRegion: 'ap-southeast-1', runnerId: 'r-1', dryRun: true })
    let result
    while (true) {
      const next = await gen.next()
      if (next.done) { result = next.value; break }
      events.push(next.value)
    }
    expect(result?.runnerId).toBe('r-1')
    expect(events.some((e) => e.type === 'stage' && e.stage === 1)).toBe(true)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd apps/infra && npx jest scale-down-runner-lib --runInBand
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `scaleDownRunner` lib**

Create `apps/infra/lib/scale-down-runner-lib.ts`. Move logic from `scripts/scale-down-runner.ts:490-820` verbatim, mapping `process.stderr.write` → `yield`. Skeleton:

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2'
import type { ProgressEvent, ScaleDownOpts, ScaleDownResult } from './runner-ops-types'
import { OperationAbortedError } from './runner-ops-types'

class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, method: string, path: string) {
    super(`API ${method} ${path} → ${status}: ${body.slice(0, 500)}`)
  }
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationAbortedError()
}

async function apiFetch<T>(
  baseUrl: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  apiPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${apiPath}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(extraHeaders ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new ApiError(res.status, text, method, apiPath)
  return (text ? JSON.parse(text) : ({} as T)) as T
}

export async function* scaleDownRunner(
  opts: ScaleDownOpts,
): AsyncGenerator<ProgressEvent, ScaleDownResult, void> {
  const start = Date.now()
  checkAborted(opts.signal)

  // ─── Stage 1: preflight ────────────────────────────────────────────
  yield { type: 'stage', stage: 1, total: 10, label: 'preflight' }
  const src = await apiFetch<any>(opts.apiUrl, opts.adminToken, 'GET', `/v1/admin/runners/${opts.runnerId}/full`)
  if (src.regionType !== 'shared') throw new Error(`runner is not SHARED (got ${src.regionType})`)
  if (src.state !== 'ready') throw new Error(`runner is not READY (got ${src.state})`)
  const allShared = await apiFetch<any[]>(opts.apiUrl, opts.adminToken, 'GET', '/v1/admin/runners?regionType=shared')
  const peers = allShared.filter((r) => r.id !== src.id && r.state === 'ready' && r.region === src.region)
  if (peers.length === 0) throw new Error('no peer SHARED runner in same region; cannot migrate')
  yield { type: 'log', line: `peers in region ${src.region}: ${peers.length}` }
  yield { type: 'data', key: 'sourceApiKey', value: src.apiKey }

  if (opts.dryRun) {
    return {
      runnerId: src.id,
      sandboxesMigrated: [],
      sandboxesArchived: [],
      ec2InstancesTerminated: [],
      durationMs: Date.now() - start,
    }
  }

  // ─── Stage 2: cordon ───────────────────────────────────────────────
  yield { type: 'stage', stage: 2, total: 10, label: 'cordon source' }
  checkAborted(opts.signal)
  await apiFetch(opts.apiUrl, opts.adminToken, 'PATCH', `/v1/admin/runners/${src.id}/scheduling`, { unschedulable: true })

  // ─── Stage 3: enumerate sandboxes ──────────────────────────────────
  yield { type: 'stage', stage: 3, total: 10, label: 'enumerate sandboxes' }
  checkAborted(opts.signal)
  const sandboxes = await apiFetch<any[]>(opts.apiUrl, src.apiKey, 'GET', '/v1/sandbox/for-runner')
  const started = sandboxes.filter((s) => s.state === 'started')
  const stopped = sandboxes.filter((s) => s.state === 'stopped')
  yield { type: 'log', line: `started=${started.length} stopped=${stopped.length}` }

  // ─── Stage 4..7: stop → backup → archive → restart (per sandbox) ─
  // Move the per-sandbox loop from scripts/scale-down-runner.ts here.
  // Yield stage events at the boundaries and log events per sandbox.

  // ─── Stage 8: drain wait ───────────────────────────────────────────
  yield { type: 'stage', stage: 8, total: 10, label: 'drain wait' }
  checkAborted(opts.signal)
  // Poll src.currentStartedSandboxes == 0 ...

  // ─── Stage 9: DELETE runner row ────────────────────────────────────
  yield { type: 'stage', stage: 9, total: 10, label: 'delete runner row' }
  checkAborted(opts.signal)
  await apiFetch(opts.apiUrl, opts.adminToken, 'DELETE', `/v1/admin/runners/${src.id}`)

  // ─── Stage 10: terminate EC2 ───────────────────────────────────────
  let terminated: string[] = []
  if (!opts.skipEc2Terminate) {
    yield { type: 'stage', stage: 10, total: 10, label: 'terminate EC2' }
    const ec2 = new EC2Client({ region: opts.awsRegion })
    const describe = await ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: 'tag:RunnerId', Values: [src.id] }],
    }))
    const ids = (describe.Reservations ?? []).flatMap((r) => (r.Instances ?? []).map((i) => i.InstanceId!).filter(Boolean))
    if (ids.length > 0) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }))
      terminated = ids
    }
  }

  return {
    runnerId: src.id,
    sandboxesMigrated: started.map((s) => s.id),
    sandboxesArchived: stopped.map((s) => s.id),
    ec2InstancesTerminated: terminated,
    durationMs: Date.now() - start,
  }
}
```

When porting stages 4-7, copy the per-sandbox `stopSandbox`, `triggerBackupSmart`, `waitBackupCompleted`, `archiveSandbox`, `waitArchivedAndDetached`, `startSandbox`, `waitSandboxState` helpers from the existing script into the lib (private functions). They are pure orchestration with no UX concerns.

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd apps/infra && npx jest scale-down-runner-lib --runInBand
```

Expected: PASS, two tests.

- [ ] **Step 6: Reduce `apps/infra/scripts/scale-down-runner.ts` to a CLI shell**

Same pattern as Task 4 Step 6: import the lib, loop over events, write stage banners + per-event lines, drive `ResultWriter`. Preserve `parseArgs`, `confirmTty`, `redactApiKey` (if present), and the result file.

- [ ] **Step 7: Manual CLI regression**

```bash
cd apps/infra && BOXLITE_ADMIN_API_KEY=dummy \
  npx tsx scripts/scale-down-runner.ts --help
```

Expected: identical help text.

- [ ] **Step 8: Add CLI snapshot test**

Create `apps/infra/scripts/__tests__/scale-down-runner-cli.snapshot.test.ts` mirroring Task 4 Step 8, then run jest once to seed the snapshot.

- [ ] **Step 9: Commit**

```bash
git add apps/infra/lib/scale-down-runner-lib.ts \
        apps/infra/lib/__tests__/scale-down-runner-lib.test.ts \
        apps/infra/scripts/scale-down-runner.ts \
        apps/infra/scripts/__tests__/scale-down-runner-cli.snapshot.test.ts \
        apps/infra/scripts/__tests__/__snapshots__/
git commit -m "refactor(infra): extract scaleDownRunner into reusable lib"
```

---

## Task 6: `RunnerService.findAllFull` accepts `regionType` filter

**Files:**
- Modify: `apps/api/src/sandbox/services/runner.service.ts`

- [ ] **Step 1: Inspect the current signature**

```bash
grep -n "findAllFull" apps/api/src/sandbox/services/runner.service.ts
```

Confirm the current shape — likely `async findAllFull(): Promise<RunnerFullDto[]>`.

- [ ] **Step 2: Write the failing test**

Append to `apps/api/src/sandbox/services/__tests__/runner.service.spec.ts` (create the file if it does not exist with the standard NestJS testing scaffold):

```typescript
it('findAllFull filters by regionType when provided', async () => {
  const all = await service.findAllFull({ regionType: 'shared' })
  expect(all.every((r) => r.regionType === 'shared')).toBe(true)
})
```

You will need to seed test fixtures (`Runner` + `Region` rows). If the existing repo has no service spec, use the `MockRepository` pattern by injecting a fake `Repository<Runner>` via `TypeOrmModule.forRootAsync({ useFactory: ... })` in the testing module — or simpler, use an in-memory mock.

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd apps && yarn nx test api --testPathPattern runner.service.spec --runInBand
```

Expected: FAIL — TS2554 or runtime "regionType" unhandled.

- [ ] **Step 4: Implement the filter**

Locate `findAllFull` and amend:

```typescript
async findAllFull(
  filter?: { regionType?: 'shared' | 'custom' },
): Promise<RunnerFullDto[]> {
  const qb = this.runnerRepository.createQueryBuilder('runner')
    .leftJoinAndSelect('runner.region', 'region')
  if (filter?.regionType) {
    qb.where('region.type = :regionType', { regionType: filter.regionType })
  }
  const runners = await qb.getMany()
  return runners.map(RunnerFullDto.fromRunner)
}
```

If existing callers pass nothing, the new signature with optional arg keeps them compatible. Check all call sites:

```bash
grep -rn "findAllFull" apps/api/src 2>/dev/null
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd apps && yarn nx test api --testPathPattern runner.service.spec --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/sandbox/services/runner.service.ts \
        apps/api/src/sandbox/services/__tests__/runner.service.spec.ts
git commit -m "feat(runner): findAllFull accepts optional regionType filter"
```

---

## Task 7: `RunnerOpsJobStore` (Redis-backed)

**Files:**
- Create: `apps/api/src/admin/services/runner-ops-job-store.ts`
- Create: `apps/api/src/admin/services/__tests__/runner-ops-job-store.spec.ts`

- [ ] **Step 1: Write the failing test**

Create the spec:

```typescript
import { Test } from '@nestjs/testing'
import { getRedisToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis-mock'
import { RunnerOpsJobStore, JobRecord } from '../runner-ops-job-store'

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

  afterEach(async () => { await redis.flushall() })

  it('creates, appends, and reads a job', async () => {
    await store.create({ id: 'j1', kind: 'add-shared', startedAt: new Date().toISOString() })
    await store.appendLine('j1', 'line 1')
    await store.appendLine('j1', 'line 2')
    const job = await store.get('j1')
    expect(job?.lines).toEqual(['line 1', 'line 2'])
    expect(job?.status).toBe('RUNNING')
  })

  it('caps lines at 1000', async () => {
    await store.create({ id: 'j2', kind: 'add-shared', startedAt: new Date().toISOString() })
    for (let i = 0; i < 1500; i++) await store.appendLine('j2', `l${i}`)
    const job = await store.get('j2')
    expect(job?.lines.length).toBe(1000)
    expect(job?.lines[0]).toBe('l500')
  })

  it('finalizes with SUCCESS and result', async () => {
    await store.create({ id: 'j3', kind: 'add-shared', startedAt: new Date().toISOString() })
    await store.complete('j3', { runnerId: 'r1' })
    const job = await store.get('j3')
    expect(job?.status).toBe('SUCCESS')
    expect(job?.result).toEqual({ runnerId: 'r1' })
    expect(job?.finishedAt).toBeTruthy()
  })

  it('finalizes with FAILED on error', async () => {
    await store.create({ id: 'j4', kind: 'scale-down', startedAt: new Date().toISOString() })
    await store.fail('j4', 'boom', 5)
    const job = await store.get('j4')
    expect(job?.status).toBe('FAILED')
    expect(job?.error).toEqual({ message: 'boom', stage: 5 })
  })

  it('returns null for missing job', async () => {
    expect(await store.get('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd apps && yarn nx test api --testPathPattern runner-ops-job-store --runInBand
```

Install `ioredis-mock` if absent:

```bash
cd apps && yarn add -D ioredis-mock
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RunnerOpsJobStore`**

Create `apps/api/src/admin/services/runner-ops-job-store.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'

const KEY_PREFIX = 'runner-ops:job:'
const TTL_SECONDS = 86_400 // 24h
const MAX_LINES = 1_000

export type JobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'STALE'

export type JobKind = 'add-shared' | 'scale-down'

export interface JobRecord {
  id: string
  kind: JobKind
  status: JobStatus
  startedAt: string
  finishedAt?: string
  currentStage?: number
  totalStages?: number
  lines: string[]
  exitCode?: number
  result?: unknown
  error?: { message: string; stage?: number }
}

@Injectable()
export class RunnerOpsJobStore {
  private readonly logger = new Logger(RunnerOpsJobStore.name)

  constructor(@InjectRedis() private readonly redis: Redis) {}

  private key(id: string): string {
    return `${KEY_PREFIX}${id}`
  }

  async create(init: Pick<JobRecord, 'id' | 'kind' | 'startedAt'>): Promise<void> {
    const rec: JobRecord = { ...init, status: 'RUNNING', lines: [] }
    await this.redis.set(this.key(init.id), JSON.stringify(rec), 'EX', TTL_SECONDS)
  }

  async get(id: string): Promise<JobRecord | null> {
    const raw = await this.redis.get(this.key(id))
    if (!raw) return null
    return JSON.parse(raw) as JobRecord
  }

  private async update(id: string, fn: (rec: JobRecord) => void): Promise<void> {
    const rec = await this.get(id)
    if (!rec) {
      this.logger.warn(`update on missing job ${id}`)
      return
    }
    fn(rec)
    await this.redis.set(this.key(id), JSON.stringify(rec), 'EX', TTL_SECONDS)
  }

  async setStage(id: string, stage: number, total: number, label: string): Promise<void> {
    await this.update(id, (rec) => {
      rec.currentStage = stage
      rec.totalStages = total
      rec.lines.push(`[${stage}/${total}] ${label}`)
      if (rec.lines.length > MAX_LINES) rec.lines = rec.lines.slice(-MAX_LINES)
    })
  }

  async appendLine(id: string, line: string): Promise<void> {
    await this.update(id, (rec) => {
      rec.lines.push(line)
      if (rec.lines.length > MAX_LINES) rec.lines = rec.lines.slice(-MAX_LINES)
    })
  }

  async setResultField(id: string, key: string, value: unknown): Promise<void> {
    await this.update(id, (rec) => {
      if (!rec.result || typeof rec.result !== 'object') rec.result = {}
      ;(rec.result as Record<string, unknown>)[key] = value
    })
  }

  async complete(id: string, result: unknown): Promise<void> {
    await this.update(id, (rec) => {
      rec.status = 'SUCCESS'
      rec.finishedAt = new Date().toISOString()
      rec.exitCode = 0
      // Merge final return value over any data-event fields already stored.
      if (result && typeof result === 'object') {
        rec.result = { ...(rec.result as Record<string, unknown> | undefined), ...(result as Record<string, unknown>) }
      } else {
        rec.result = result
      }
    })
  }

  async fail(id: string, message: string, stage?: number): Promise<void> {
    await this.update(id, (rec) => {
      rec.status = 'FAILED'
      rec.finishedAt = new Date().toISOString()
      rec.error = { message, stage }
    })
  }

  async requestCancel(id: string): Promise<void> {
    await this.update(id, (rec) => {
      if (rec.status === 'RUNNING') rec.status = 'CANCEL_REQUESTED'
    })
  }

  async tryAcquireLock(kind: JobKind, jobId: string, ttlSec: number): Promise<boolean> {
    const lockKey = `runner-ops:lock:${kind}`
    const res = await this.redis.set(lockKey, jobId, 'EX', ttlSec, 'NX')
    return res === 'OK'
  }

  async releaseLock(kind: JobKind, jobId: string): Promise<void> {
    const lockKey = `runner-ops:lock:${kind}`
    const current = await this.redis.get(lockKey)
    if (current === jobId) await this.redis.del(lockKey)
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd apps && yarn nx test api --testPathPattern runner-ops-job-store --runInBand
```

Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/admin/services/runner-ops-job-store.ts \
        apps/api/src/admin/services/__tests__/runner-ops-job-store.spec.ts \
        apps/package.json apps/yarn.lock
git commit -m "feat(admin): runner-ops Redis-backed job store"
```

---

## Task 8: `RunnerOpsService` orchestrator

**Files:**
- Create: `apps/api/src/admin/services/runner-ops.service.ts`
- Create: `apps/api/src/admin/services/__tests__/runner-ops.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { Test } from '@nestjs/testing'
import { ulid } from 'ulid'
import { RunnerOpsService } from '../runner-ops.service'
import { RunnerOpsJobStore, JobRecord } from '../runner-ops-job-store'
import { ConfigService } from '@nestjs/config' // use TypedConfigService if that's the project standard

class FakeStore implements Partial<RunnerOpsJobStore> {
  jobs = new Map<string, JobRecord>()
  lock: string | null = null
  async tryAcquireLock(_kind: any, id: string) { if (this.lock) return false; this.lock = id; return true }
  async releaseLock() { this.lock = null }
  async create(init: any) { this.jobs.set(init.id, { ...init, status: 'RUNNING', lines: [] }) }
  async setStage(id: string, s: number, t: number, l: string) { this.jobs.get(id)?.lines.push(`[${s}/${t}] ${l}`) }
  async appendLine(id: string, l: string) { this.jobs.get(id)?.lines.push(l) }
  async setResultField(id: string, k: string, v: unknown) { const r = this.jobs.get(id); if (!r) return; r.result = { ...(r.result as any), [k]: v } }
  async complete(id: string, r: unknown) { const j = this.jobs.get(id)!; j.status = 'SUCCESS'; j.result = { ...(j.result as any), ...(r as any) } }
  async fail(id: string, m: string, s?: number) { const j = this.jobs.get(id)!; j.status = 'FAILED'; j.error = { message: m, stage: s } }
  async get(id: string) { return this.jobs.get(id) ?? null }
}

describe('RunnerOpsService', () => {
  let service: RunnerOpsService
  let store: FakeStore

  beforeEach(async () => {
    store = new FakeStore()
    const mod = await Test.createTestingModule({
      providers: [
        RunnerOpsService,
        { provide: RunnerOpsJobStore, useValue: store },
        { provide: 'TypedConfigService', useValue: { get: (k: string) => ({ 'runnerOps.adminToken': 'tok', 'runnerOps.awsRegion': 'us-1' } as any)[k] } },
      ],
    }).compile()
    service = mod.get(RunnerOpsService)
  })

  it('rejects a second add-shared job while one is running', async () => {
    const mockGen = async function* () { await new Promise((r) => setTimeout(r, 20)); return { runnerId: 'r1' } as any }
    ;(service as any).runAddSharedRunner = () => mockGen()
    const a = await service.startAddSharedRunner({ apiUrl: 'http://api', name: 'a' })
    await expect(service.startAddSharedRunner({ apiUrl: 'http://api', name: 'b' })).rejects.toMatchObject({ status: 409 })
    // wait for first to finish
    await new Promise((r) => setTimeout(r, 80))
    expect(store.jobs.get(a.id)?.status).toBe('SUCCESS')
  })

  it('records failure on lib throw', async () => {
    ;(service as any).runAddSharedRunner = async function* () { throw new Error('aws-boom') }
    const j = await service.startAddSharedRunner({ apiUrl: 'http://api' })
    await new Promise((r) => setTimeout(r, 50))
    expect(store.jobs.get(j.id)?.status).toBe('FAILED')
    expect(store.jobs.get(j.id)?.error?.message).toMatch(/aws-boom/)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd apps && yarn nx test api --testPathPattern runner-ops.service.spec --runInBand
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RunnerOpsService`**

```typescript
import { Injectable, Logger, ConflictException } from '@nestjs/common'
import { ulid } from 'ulid'
import { addSharedRunner } from '../../../../../infra/lib/add-shared-runner-lib'
import { scaleDownRunner } from '../../../../../infra/lib/scale-down-runner-lib'
import type {
  AddSharedRunnerOpts,
  ScaleDownOpts,
  ProgressEvent,
} from '../../../../../infra/lib/runner-ops-types'
import { TypedConfigService } from '../../config/typed-config.service'
import { RunnerOpsJobStore } from './runner-ops-job-store'

const ADD_LOCK_TTL = 1_800
const SCALE_LOCK_TTL = 3_600

@Injectable()
export class RunnerOpsService {
  private readonly logger = new Logger(RunnerOpsService.name)

  constructor(
    private readonly store: RunnerOpsJobStore,
    private readonly configService: TypedConfigService,
  ) {}

  async startAddSharedRunner(input: Partial<AddSharedRunnerOpts> & { apiUrl?: string }): Promise<{ id: string }> {
    const id = ulid()
    const acquired = await this.store.tryAcquireLock('add-shared', id, ADD_LOCK_TTL)
    if (!acquired) {
      const err: any = new ConflictException('another add-shared job is running')
      err.status = 409
      throw err
    }
    await this.store.create({ id, kind: 'add-shared', startedAt: new Date().toISOString() })

    const opts: AddSharedRunnerOpts = {
      apiUrl: input.apiUrl ?? this.configService.getOrThrow('runnerOps.apiUrl'),
      adminToken: this.configService.getOrThrow('runnerOps.adminToken'),
      awsRegion: this.configService.getOrThrow('runnerOps.awsRegion'),
      name: input.name,
      regionId: input.regionId,
      instanceType: input.instanceType,
      diskGb: input.diskGb,
      withBackupSidecar: input.withBackupSidecar,
      registryUrl: this.configService.get('runnerOps.registryUrl'),
      subnetId: this.configService.get('runnerOps.subnetId'),
      instanceProfileName: this.configService.get('runnerOps.instanceProfileName'),
      timeoutSec: input.timeoutSec,
      noWait: false,
    }

    // Fire-and-forget; pump events into store.
    void this.pumpAdd(id, opts)
    return { id }
  }

  async startScaleDownRunner(runnerId: string, input: Partial<ScaleDownOpts>): Promise<{ id: string }> {
    const id = ulid()
    const acquired = await this.store.tryAcquireLock('scale-down', id, SCALE_LOCK_TTL)
    if (!acquired) {
      const err: any = new ConflictException('another scale-down job is running')
      err.status = 409
      throw err
    }
    await this.store.create({ id, kind: 'scale-down', startedAt: new Date().toISOString() })

    const opts: ScaleDownOpts = {
      apiUrl: this.configService.getOrThrow('runnerOps.apiUrl'),
      adminToken: this.configService.getOrThrow('runnerOps.adminToken'),
      awsRegion: this.configService.getOrThrow('runnerOps.awsRegion'),
      runnerId,
      restartStopped: input.restartStopped,
      skipEc2Terminate: input.skipEc2Terminate,
      dryRun: input.dryRun,
      maxWaitBackupSec: input.maxWaitBackupSec,
      maxWaitStopSec: input.maxWaitStopSec,
      maxWaitArchiveSec: input.maxWaitArchiveSec,
      maxWaitStartSec: input.maxWaitStartSec,
    }
    void this.pumpScaleDown(id, opts)
    return { id }
  }

  async getJob(jobId: string) {
    return this.store.get(jobId)
  }

  async requestCancel(jobId: string) {
    await this.store.requestCancel(jobId)
    return this.store.get(jobId)
  }

  // Injection seam for tests
  protected runAddSharedRunner(opts: AddSharedRunnerOpts) {
    return addSharedRunner(opts)
  }

  protected runScaleDownRunner(opts: ScaleDownOpts) {
    return scaleDownRunner(opts)
  }

  private async pumpAdd(id: string, opts: AddSharedRunnerOpts): Promise<void> {
    let currentStage = 0
    try {
      const gen = this.runAddSharedRunner(opts)
      while (true) {
        const next = await gen.next()
        if (next.done) {
          await this.store.complete(id, next.value)
          break
        }
        await this.applyEvent(id, next.value, (s) => { currentStage = s })
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      this.logger.error(`add-shared job ${id} failed: ${msg}`)
      await this.store.fail(id, msg, currentStage || undefined)
    } finally {
      await this.store.releaseLock('add-shared', id)
    }
  }

  private async pumpScaleDown(id: string, opts: ScaleDownOpts): Promise<void> {
    let currentStage = 0
    try {
      const gen = this.runScaleDownRunner(opts)
      while (true) {
        const next = await gen.next()
        if (next.done) {
          await this.store.complete(id, next.value)
          break
        }
        await this.applyEvent(id, next.value, (s) => { currentStage = s })
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      this.logger.error(`scale-down job ${id} failed: ${msg}`)
      await this.store.fail(id, msg, currentStage || undefined)
    } finally {
      await this.store.releaseLock('scale-down', id)
    }
  }

  private async applyEvent(jobId: string, ev: ProgressEvent, setStage: (s: number) => void): Promise<void> {
    if (ev.type === 'stage') {
      setStage(ev.stage)
      await this.store.setStage(jobId, ev.stage, ev.total, ev.label)
    } else if (ev.type === 'log') {
      await this.store.appendLine(jobId, ev.line)
    } else if (ev.type === 'warning') {
      await this.store.appendLine(jobId, `WARN: ${ev.line}`)
    } else if (ev.type === 'data') {
      await this.store.setResultField(jobId, ev.key, ev.value)
    }
  }
}
```

Add `ulid` if it's not already a dependency:

```bash
cd apps && yarn list ulid 2>&1 | grep ulid || yarn add ulid
```

- [ ] **Step 4: Add configuration shape**

Verify `TypedConfigService` exposes `runnerOps.*`. If not, add a section to `apps/api/src/config/configuration.ts`:

```typescript
runnerOps: {
  apiUrl: env('BOXLITE_RUNNER_OPS_API_URL', 'http://localhost:3000'),
  adminToken: env('BOXLITE_RUNNER_OPS_ADMIN_TOKEN'),
  awsRegion: env('BOXLITE_RUNNER_OPS_AWS_REGION', 'ap-southeast-1'),
  subnetId: env('BOXLITE_RUNNER_OPS_SUBNET_ID'),
  instanceProfileName: env('BOXLITE_RUNNER_OPS_INSTANCE_PROFILE'),
  registryUrl: env('BOXLITE_RUNNER_OPS_REGISTRY_URL'),
},
```

Follow the project's exact pattern (TypedConfigService schema may use a different shape).

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd apps && yarn nx test api --testPathPattern runner-ops.service.spec --runInBand
```

Expected: PASS, two tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/admin/services/runner-ops.service.ts \
        apps/api/src/admin/services/__tests__/runner-ops.service.spec.ts \
        apps/api/src/config/configuration.ts \
        apps/package.json apps/yarn.lock
git commit -m "feat(admin): runner-ops service orchestrating lib generators"
```

---

## Task 9: DTOs

**Files:**
- Create: `apps/api/src/admin/dto/runner-ops.dto.ts`

- [ ] **Step 1: Create the DTOs**

```typescript
// SPDX-License-Identifier: AGPL-3.0
// Modified by BoxLite AI, 2026

import { ApiProperty, ApiSchema, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, IsBoolean, IsInt, Min, Max, Matches } from 'class-validator'
import { RunnerState } from '../../sandbox/enums/runner-state.enum'

@ApiSchema({ name: 'AddSharedRunnerRequest' })
export class AddSharedRunnerRequestDto {
  @ApiPropertyOptional({ description: 'Runner name; auto-generated if omitted' })
  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9_.-]+$/)
  name?: string

  @ApiPropertyOptional({ description: 'Region ID; default "us"' })
  @IsOptional() @IsString()
  regionId?: string

  @ApiPropertyOptional({ description: 'EC2 instance type; default c8i.2xlarge' })
  @IsOptional() @IsString()
  instanceType?: string

  @ApiPropertyOptional({ description: 'EBS root volume size in GB; default 100' })
  @IsOptional() @IsInt() @Min(30) @Max(2000)
  diskGb?: number

  @ApiPropertyOptional({ description: 'Install backup sidecar (dev-only)' })
  @IsOptional() @IsBoolean()
  withBackupSidecar?: boolean

  @ApiPropertyOptional({ description: 'Readiness poll timeout seconds; default 600' })
  @IsOptional() @IsInt() @Min(30) @Max(3600)
  timeoutSec?: number
}

@ApiSchema({ name: 'ScaleDownRequest' })
export class ScaleDownRequestDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  restartStopped?: boolean

  @ApiPropertyOptional({ description: 'Debug: do not terminate EC2 after deleting runner row' })
  @IsOptional() @IsBoolean()
  skipEc2Terminate?: boolean

  @ApiPropertyOptional({ description: 'Run preflight only, no side effects' })
  @IsOptional() @IsBoolean()
  dryRun?: boolean

  @ApiPropertyOptional({ description: 'Per-stage timeouts in seconds' })
  @IsOptional() @IsInt() @Min(30) @Max(3600)
  maxWaitBackupSec?: number

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(30) @Max(3600)
  maxWaitStopSec?: number

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(30) @Max(3600)
  maxWaitArchiveSec?: number

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(30) @Max(3600)
  maxWaitStartSec?: number
}

export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCEL_REQUESTED' | 'STALE'

@ApiSchema({ name: 'JobError' })
export class JobErrorDto {
  @ApiProperty() message: string
  @ApiPropertyOptional() stage?: number
}

@ApiSchema({ name: 'Job' })
export class JobDto {
  @ApiProperty() id: string
  @ApiProperty({ enum: ['add-shared', 'scale-down'] }) kind: 'add-shared' | 'scale-down'
  @ApiProperty({ enum: ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCEL_REQUESTED', 'STALE'] })
  status: JobStatus
  @ApiProperty() startedAt: string
  @ApiPropertyOptional() finishedAt?: string
  @ApiPropertyOptional() currentStage?: number
  @ApiPropertyOptional() totalStages?: number
  @ApiProperty({ type: [String] }) lines: string[]
  @ApiPropertyOptional() exitCode?: number
  @ApiPropertyOptional({ type: Object }) result?: unknown
  @ApiPropertyOptional({ type: () => JobErrorDto }) error?: JobErrorDto
}

@ApiSchema({ name: 'SharedRunnerSummary' })
export class SharedRunnerSummaryDto {
  @ApiProperty() id: string
  @ApiProperty() name: string
  @ApiProperty() regionId: string
  @ApiProperty({ enum: RunnerState }) state: RunnerState
  @ApiProperty() availabilityScore: number
  @ApiProperty() cpu: number
  @ApiProperty() memoryGiB: number
  @ApiProperty() diskGiB: number
  @ApiProperty() currentStartedSandboxes: number
  @ApiProperty() currentCpuUsagePercentage: number
  @ApiProperty() currentMemoryUsagePercentage: number
  @ApiProperty() currentDiskUsagePercentage: number
  @ApiProperty() unschedulable: boolean
  @ApiProperty() draining: boolean
  @ApiProperty() lastChecked: string
}

@ApiSchema({ name: 'ListSharedRunnersResponse' })
export class ListSharedRunnersResponseDto {
  @ApiProperty({ type: [SharedRunnerSummaryDto] })
  runners: SharedRunnerSummaryDto[]
}
```

- [ ] **Step 2: Verify the DTOs compile**

```bash
cd apps && ./node_modules/.bin/tsc -p api/tsconfig.app.json --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/admin/dto/runner-ops.dto.ts
git commit -m "feat(admin): DTOs for runner-ops endpoints"
```

---

## Task 10: `RunnerOpsController` + module wiring + e2e test

**Files:**
- Create: `apps/api/src/admin/controllers/runner-ops.controller.ts`
- Create: `apps/api/src/admin/controllers/__tests__/runner-ops.controller.spec.ts`
- Modify: `apps/api/src/admin/admin.module.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { Test } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import * as request from 'supertest'
import { AdminModule } from '../../admin.module'
import { SystemActionGuard } from '../../../auth/system-action.guard'
import { RunnerOpsService } from '../../services/runner-ops.service'

describe('RunnerOpsController', () => {
  let app: INestApplication
  const service = {
    listShared: jest.fn(),
    startAddSharedRunner: jest.fn(),
    startScaleDownRunner: jest.fn(),
    getJob: jest.fn(),
    requestCancel: jest.fn(),
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AdminModule] })
      .overrideProvider(RunnerOpsService).useValue(service)
      .overrideGuard(SystemActionGuard).useValue({ canActivate: () => true })
      .compile()
    app = mod.createNestApplication()
    await app.init()
  })

  afterAll(async () => { await app.close() })

  it('GET /admin/runner-ops/shared returns the list', async () => {
    service.listShared.mockResolvedValueOnce({ runners: [{ id: 'r1', name: 'a' }] })
    const r = await request(app.getHttpServer()).get('/admin/runner-ops/shared').expect(200)
    expect(r.body.runners).toHaveLength(1)
  })

  it('POST /admin/runner-ops/add-shared returns 202 with jobId', async () => {
    service.startAddSharedRunner.mockResolvedValueOnce({ id: 'j-1' })
    const r = await request(app.getHttpServer()).post('/admin/runner-ops/add-shared').send({ name: 'r' }).expect(202)
    expect(r.body.id).toBe('j-1')
  })

  it('POST /admin/runner-ops/:id/scale-down returns 202', async () => {
    service.startScaleDownRunner.mockResolvedValueOnce({ id: 'j-2' })
    const r = await request(app.getHttpServer()).post('/admin/runner-ops/r-1/scale-down').send({}).expect(202)
    expect(r.body.id).toBe('j-2')
  })

  it('GET /admin/runner-ops/jobs/:id returns 404 when missing', async () => {
    service.getJob.mockResolvedValueOnce(null)
    await request(app.getHttpServer()).get('/admin/runner-ops/jobs/missing').expect(404)
  })

  it('POST /admin/runner-ops/jobs/:id/cancel returns the updated job', async () => {
    service.requestCancel.mockResolvedValueOnce({ id: 'j-1', status: 'CANCEL_REQUESTED' })
    const r = await request(app.getHttpServer()).post('/admin/runner-ops/jobs/j-1/cancel').expect(200)
    expect(r.body.status).toBe('CANCEL_REQUESTED')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd apps && yarn nx test api --testPathPattern runner-ops.controller.spec --runInBand
```

Expected: FAIL — controller not found.

- [ ] **Step 3: Implement the controller**

```typescript
import { Body, Controller, Get, HttpCode, Logger, NotFoundException, Param, Post, UseGuards } from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredSystemRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { RunnerOpsService } from '../services/runner-ops.service'
import { RunnerService } from '../../sandbox/services/runner.service'
import {
  AddSharedRunnerRequestDto,
  ScaleDownRequestDto,
  JobDto,
  ListSharedRunnersResponseDto,
  SharedRunnerSummaryDto,
} from '../dto/runner-ops.dto'

@ApiTags('admin-runner-ops')
@ApiBearerAuth()
@Controller('admin/runner-ops')
@UseGuards(AuthGuard(['bearer']), SystemActionGuard)
@RequiredSystemRole(SystemRole.ADMIN)
export class RunnerOpsController {
  private readonly logger = new Logger(RunnerOpsController.name)

  constructor(
    private readonly service: RunnerOpsService,
    private readonly runnerService: RunnerService,
  ) {}

  @Get('shared')
  @ApiOperation({ operationId: 'listSharedRunners' })
  @ApiResponse({ status: 200, type: ListSharedRunnersResponseDto })
  async listShared(): Promise<ListSharedRunnersResponseDto> {
    const all = await this.runnerService.findAllFull({ regionType: 'shared' })
    const runners: SharedRunnerSummaryDto[] = all.map((r) => ({
      id: r.id,
      name: r.name,
      regionId: r.region,
      state: r.state,
      availabilityScore: r.availabilityScore,
      cpu: r.cpu,
      memoryGiB: r.memoryGiB,
      diskGiB: r.diskGiB,
      currentStartedSandboxes: r.currentStartedSandboxes,
      currentCpuUsagePercentage: r.currentCpuUsagePercentage,
      currentMemoryUsagePercentage: r.currentMemoryUsagePercentage,
      currentDiskUsagePercentage: r.currentDiskUsagePercentage,
      unschedulable: r.unschedulable,
      draining: r.draining,
      lastChecked: (r.lastChecked as Date | string).toString(),
    }))
    return { runners }
  }

  @Post('add-shared')
  @HttpCode(202)
  @ApiOperation({ operationId: 'addSharedRunner' })
  @ApiResponse({ status: 202, schema: { type: 'object', properties: { id: { type: 'string' } } } })
  async addShared(@Body() body: AddSharedRunnerRequestDto): Promise<{ id: string }> {
    return this.service.startAddSharedRunner(body)
  }

  @Post(':runnerId/scale-down')
  @HttpCode(202)
  @ApiOperation({ operationId: 'scaleDownRunner' })
  async scaleDown(@Param('runnerId') runnerId: string, @Body() body: ScaleDownRequestDto): Promise<{ id: string }> {
    return this.service.startScaleDownRunner(runnerId, body)
  }

  @Get('jobs/:jobId')
  @ApiOperation({ operationId: 'getRunnerOpsJob' })
  @ApiResponse({ status: 200, type: JobDto })
  async getJob(@Param('jobId') jobId: string): Promise<JobDto> {
    const job = await this.service.getJob(jobId)
    if (!job) throw new NotFoundException(`job ${jobId} not found`)
    return job as JobDto
  }

  @Post('jobs/:jobId/cancel')
  @ApiOperation({ operationId: 'cancelRunnerOpsJob' })
  @ApiResponse({ status: 200, type: JobDto })
  async cancelJob(@Param('jobId') jobId: string): Promise<JobDto> {
    const job = await this.service.requestCancel(jobId)
    if (!job) throw new NotFoundException(`job ${jobId} not found`)
    return job as JobDto
  }
}
```

- [ ] **Step 4: Wire into `AdminModule`**

Modify `apps/api/src/admin/admin.module.ts`:

```typescript
import { Module } from '@nestjs/common'
import { AdminRunnerController } from './controllers/runner.controller'
import { AdminSandboxController } from './controllers/sandbox.controller'
import { RunnerOpsController } from './controllers/runner-ops.controller'
import { RunnerOpsService } from './services/runner-ops.service'
import { RunnerOpsJobStore } from './services/runner-ops-job-store'
import { SandboxModule } from '../sandbox/sandbox.module'
import { RegionModule } from '../region/region.module'
import { OrganizationModule } from '../organization/organization.module'

@Module({
  imports: [SandboxModule, RegionModule, OrganizationModule],
  controllers: [AdminRunnerController, AdminSandboxController, RunnerOpsController],
  providers: [RunnerOpsService, RunnerOpsJobStore],
})
export class AdminModule {}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd apps && yarn nx test api --testPathPattern runner-ops.controller.spec --runInBand
```

Expected: PASS, five tests.

- [ ] **Step 6: Smoke-test with curl (requires running API)**

If you have `apps/infra-local` up:

```bash
ADMIN=$(cat ~/.boxlite/admin-token)
API=http://api.boxlite.test
curl -fsS -H "Authorization: Bearer $ADMIN" "$API/v1/admin/runner-ops/shared" | jq .
curl -fsS -X POST -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"runner-test"}' "$API/v1/admin/runner-ops/add-shared" | jq .
```

Expected: list returns; add returns 202 with `{ "id": "01HQ..." }`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/admin/controllers/runner-ops.controller.ts \
        apps/api/src/admin/controllers/__tests__/runner-ops.controller.spec.ts \
        apps/api/src/admin/admin.module.ts
git commit -m "feat(admin): runner-ops admin REST endpoints"
```

---

## Task 11: Regenerate api-client for new endpoints

**Files:**
- Auto-generated: `libs/api-client-ts/**`

- [ ] **Step 1: Regenerate**

```bash
cd apps && yarn nx run api-client-ts:generate
```

- [ ] **Step 2: Verify new types and APIs are present**

```bash
grep -rn "AddSharedRunner\|RunnerOps\|SharedRunnerSummary" libs/api-client-ts/src/ | head -10
```

Expected: lines under `apis/` and `models/`.

- [ ] **Step 3: Commit**

```bash
git add libs/api-client-ts/
git commit -m "chore(api-client): regenerate for runner-ops endpoints"
```

---

## Task 12: `useRunnerOpsJob` polling hook

**Files:**
- Create: `apps/dashboard/src/hooks/useRunnerOpsJob.ts`
- Create: `apps/dashboard/src/hooks/__tests__/useRunnerOpsJob.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useRunnerOpsJob } from '../useRunnerOpsJob'
import { ApiContext } from '@/contexts/ApiContext'
import React from 'react'

vi.useFakeTimers()

function withApi(getJob: (id: string) => Promise<any>) {
  const value = { adminRunnerOpsApi: { getRunnerOpsJob: (id: string) => getJob(id).then((data) => ({ data })) } } as any
  return ({ children }: { children: React.ReactNode }) => (
    <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
  )
}

describe('useRunnerOpsJob', () => {
  afterEach(() => { vi.clearAllTimers() })

  it('polls until SUCCESS and stops', async () => {
    let n = 0
    const get = vi.fn(async () => ({ id: 'j', status: n++ < 2 ? 'RUNNING' : 'SUCCESS', lines: ['l'] }))
    const { result } = renderHook(() => useRunnerOpsJob('j'), { wrapper: withApi(get) })
    await waitFor(() => expect(result.current.status).toBe('RUNNING'))
    await act(async () => { vi.advanceTimersByTime(2000) })
    await act(async () => { vi.advanceTimersByTime(2000) })
    await waitFor(() => expect(result.current.status).toBe('SUCCESS'))
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('stops on unmount', async () => {
    const get = vi.fn(async () => ({ id: 'j', status: 'RUNNING', lines: [] }))
    const { unmount } = renderHook(() => useRunnerOpsJob('j'), { wrapper: withApi(get) })
    unmount()
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(get).toHaveBeenCalledTimes(1) // only the initial call
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd apps && yarn nx test dashboard --testPathPattern useRunnerOpsJob
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```typescript
import { useEffect, useState, useRef } from 'react'
import { Job, JobStatusEnum } from '@boxlite-ai/api-client'
import { useApi } from './useApi'

const POLL_MS = 2000
const TERMINAL: string[] = ['SUCCESS', 'FAILED', 'STALE']

export interface UseRunnerOpsJobState {
  job: Job | null
  status: string | undefined
  lines: string[]
  result: unknown
  error: Error | null
  loading: boolean
}

export function useRunnerOpsJob(jobId: string | null): UseRunnerOpsJobState {
  const { adminRunnerOpsApi } = useApi() as any
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    if (!jobId) { setJob(null); return }
    setLoading(true)

    const tick = async () => {
      if (cancelled.current) return
      try {
        const res = await adminRunnerOpsApi.getRunnerOpsJob(jobId)
        if (cancelled.current) return
        setJob(res.data)
        setLoading(false)
        if (res.data && !TERMINAL.includes(res.data.status)) {
          setTimeout(tick, POLL_MS)
        }
      } catch (e) {
        if (cancelled.current) return
        setError(e as Error)
        setLoading(false)
      }
    }
    tick()

    return () => { cancelled.current = true }
  }, [jobId])

  return {
    job,
    status: job?.status,
    lines: job?.lines ?? [],
    result: job?.result,
    error,
    loading,
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd apps && yarn nx test dashboard --testPathPattern useRunnerOpsJob
```

Expected: PASS, two tests.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/hooks/useRunnerOpsJob.ts \
        apps/dashboard/src/hooks/__tests__/useRunnerOpsJob.test.tsx
git commit -m "feat(dashboard): runner-ops job polling hook"
```

---

## Task 13: `RunnerOpsTable` component

**Files:**
- Create: `apps/dashboard/src/components/admin/RunnerOpsTable.tsx`

- [ ] **Step 1: Implement the table**

Use the existing `RunnerTable.tsx` (`apps/dashboard/src/components/RunnerTable.tsx`) as a starting point. Read its props and column setup, then create the admin variant:

```typescript
import React from 'react'
import type { SharedRunnerSummary } from '@boxlite-ai/api-client'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

export interface RunnerOpsTableProps {
  runners: SharedRunnerSummary[]
  onScaleDown: (runner: SharedRunnerSummary) => void
  loading?: boolean
  inProgressId?: string | null
}

export const RunnerOpsTable: React.FC<RunnerOpsTableProps> = ({ runners, onScaleDown, loading, inProgressId }) => {
  if (loading) return <div>Loading runners…</div>
  if (!runners.length) return <div className="text-muted-foreground">No shared runners.</div>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Region</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="text-right">Score</TableHead>
          <TableHead className="text-right">Sandboxes</TableHead>
          <TableHead className="text-right">CPU / Mem / Disk</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runners.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-mono">{r.name}</TableCell>
            <TableCell>{r.regionId}</TableCell>
            <TableCell>
              <Badge variant={r.state === 'ready' ? 'default' : 'secondary'}>{r.state}</Badge>
              {r.draining && <Badge variant="destructive" className="ml-1">draining</Badge>}
              {r.unschedulable && <Badge variant="outline" className="ml-1">cordoned</Badge>}
            </TableCell>
            <TableCell className="text-right">{r.availabilityScore}</TableCell>
            <TableCell className="text-right">{r.currentStartedSandboxes}</TableCell>
            <TableCell className="text-right">
              {Math.round(r.currentCpuUsagePercentage)}% / {Math.round(r.currentMemoryUsagePercentage)}% / {Math.round(r.currentDiskUsagePercentage)}%
            </TableCell>
            <TableCell>
              <Button
                size="sm"
                variant="destructive"
                disabled={r.draining || inProgressId === r.id}
                onClick={() => onScaleDown(r)}
              >
                {inProgressId === r.id ? 'Scaling down…' : 'Scale down'}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps && ./node_modules/.bin/tsc -p dashboard/tsconfig.app.json --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/admin/RunnerOpsTable.tsx
git commit -m "feat(dashboard): RunnerOpsTable component"
```

---

## Task 14: `AddSharedRunnerDialog` component

**Files:**
- Create: `apps/dashboard/src/components/admin/AddSharedRunnerDialog.tsx`

- [ ] **Step 1: Implement the dialog**

```typescript
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { useApi } from '@/hooks/useApi'
import { useRunnerOpsJob } from '@/hooks/useRunnerOpsJob'

export interface AddSharedRunnerDialogProps {
  onCompleted?: () => void
}

export const AddSharedRunnerDialog: React.FC<AddSharedRunnerDialogProps> = ({ onCompleted }) => {
  const { adminRunnerOpsApi } = useApi() as any
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [regionId, setRegionId] = useState('us')
  const [instanceType, setInstanceType] = useState('c8i.2xlarge')
  const [jobId, setJobId] = useState<string | null>(null)
  const { job, status, lines } = useRunnerOpsJob(jobId)

  const submit = async () => {
    try {
      const res = await adminRunnerOpsApi.addSharedRunner({ name: name || undefined, regionId, instanceType })
      setJobId(res.data.id)
      toast.info('Add runner started')
    } catch (e: any) {
      toast.error(`Failed to start: ${e?.message ?? 'unknown'}`)
    }
  }

  React.useEffect(() => {
    if (status === 'SUCCESS') { toast.success('Runner added'); onCompleted?.() }
    if (status === 'FAILED') toast.error(`Add failed: ${job?.error?.message}`)
  }, [status, job?.error?.message, onCompleted])

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setJobId(null); setName('') } }}>
      <DialogTrigger asChild>
        <Button>+ Add runner</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a shared runner</DialogTitle>
          <DialogDescription>Provisions an EC2 instance and registers it as a SHARED runner.</DialogDescription>
        </DialogHeader>

        {!jobId && (
          <div className="grid gap-3 py-2">
            <div className="grid gap-1">
              <Label htmlFor="name">Name (optional)</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="runner-shared-abc123" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="regionId">Region</Label>
              <Input id="regionId" value={regionId} onChange={(e) => setRegionId(e.target.value)} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="instanceType">EC2 instance type</Label>
              <Input id="instanceType" value={instanceType} onChange={(e) => setInstanceType(e.target.value)} />
            </div>
          </div>
        )}

        {jobId && (
          <div className="py-2">
            <div className="text-sm mb-2">Status: <span className="font-semibold">{status}</span></div>
            <pre className="bg-muted text-xs p-2 rounded max-h-64 overflow-auto">{lines.join('\n')}</pre>
          </div>
        )}

        <DialogFooter>
          {!jobId && (
            <>
              <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
              <Button onClick={submit}>Add runner</Button>
            </>
          )}
          {jobId && (status === 'SUCCESS' || status === 'FAILED') && (
            <DialogClose asChild><Button>Close</Button></DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps && ./node_modules/.bin/tsc -p dashboard/tsconfig.app.json --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/admin/AddSharedRunnerDialog.tsx
git commit -m "feat(dashboard): AddSharedRunnerDialog with live job polling"
```

---

## Task 15: `ScaleDownDialog` component

**Files:**
- Create: `apps/dashboard/src/components/admin/ScaleDownDialog.tsx`

- [ ] **Step 1: Implement the dialog**

```typescript
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import type { SharedRunnerSummary } from '@boxlite-ai/api-client'
import { useApi } from '@/hooks/useApi'
import { useRunnerOpsJob } from '@/hooks/useRunnerOpsJob'

export interface ScaleDownDialogProps {
  runner: SharedRunnerSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCompleted?: () => void
}

export const ScaleDownDialog: React.FC<ScaleDownDialogProps> = ({ runner, open, onOpenChange, onCompleted }) => {
  const { adminRunnerOpsApi } = useApi() as any
  const [restartStopped, setRestartStopped] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const { job, status, lines } = useRunnerOpsJob(jobId)

  const submit = async () => {
    if (!runner) return
    try {
      const res = await adminRunnerOpsApi.scaleDownRunner(runner.id, { restartStopped })
      setJobId(res.data.id)
    } catch (e: any) {
      toast.error(`Failed to start: ${e?.message ?? 'unknown'}`)
    }
  }

  React.useEffect(() => {
    if (status === 'SUCCESS') { toast.success(`Scaled down ${runner?.name}`); onCompleted?.() }
    if (status === 'FAILED') toast.error(`Scale-down failed: ${job?.error?.message}`)
  }, [status, job?.error?.message, runner?.name, onCompleted])

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setJobId(null) }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Scale down {runner?.name}</DialogTitle>
          <DialogDescription>
            All running sandboxes will be backed up, archived, and restarted on peer SHARED runners.
            After migration, the runner row is deleted and the EC2 instance is terminated.
          </DialogDescription>
        </DialogHeader>

        {!jobId && (
          <div className="grid gap-3 py-2">
            <div className="flex items-center gap-2">
              <Checkbox id="restartStopped" checked={restartStopped} onCheckedChange={(v) => setRestartStopped(!!v)} />
              <Label htmlFor="restartStopped">Also migrate STOPPED sandboxes (default: archive only)</Label>
            </div>
          </div>
        )}

        {jobId && (
          <div className="py-2">
            <div className="text-sm mb-2">Status: <span className="font-semibold">{status}</span></div>
            <pre className="bg-muted text-xs p-2 rounded max-h-80 overflow-auto">{lines.join('\n')}</pre>
          </div>
        )}

        <DialogFooter>
          {!jobId && (
            <>
              <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
              <Button variant="destructive" onClick={submit}>Scale down</Button>
            </>
          )}
          {jobId && (status === 'SUCCESS' || status === 'FAILED') && (
            <DialogClose asChild><Button>Close</Button></DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps && ./node_modules/.bin/tsc -p dashboard/tsconfig.app.json --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/admin/ScaleDownDialog.tsx
git commit -m "feat(dashboard): ScaleDownDialog with confirmation + live job polling"
```

---

## Task 16: `RunnerOps` page + routing + sidebar entry

**Files:**
- Create: `apps/dashboard/src/pages/admin/RunnerOps.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: dashboard sidebar component (locate first)

- [ ] **Step 1: Create the page**

```typescript
import React, { useCallback, useEffect, useState } from 'react'
import type { SharedRunnerSummary } from '@boxlite-ai/api-client'
import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { useApi } from '@/hooks/useApi'
import { handleApiError } from '@/lib/error-handling'
import { RunnerOpsTable } from '@/components/admin/RunnerOpsTable'
import { AddSharedRunnerDialog } from '@/components/admin/AddSharedRunnerDialog'
import { ScaleDownDialog } from '@/components/admin/ScaleDownDialog'

const RunnerOps: React.FC = () => {
  const { adminRunnerOpsApi } = useApi() as any
  const [runners, setRunners] = useState<SharedRunnerSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [scaleDownTarget, setScaleDownTarget] = useState<SharedRunnerSummary | null>(null)

  const fetchRunners = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminRunnerOpsApi.listSharedRunners()
      setRunners(res.data.runners ?? [])
    } catch (e) {
      handleApiError(e, 'Failed to load runners')
    } finally {
      setLoading(false)
    }
  }, [adminRunnerOpsApi])

  useEffect(() => { fetchRunners() }, [fetchRunners])

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Runner Ops</PageTitle>
        <AddSharedRunnerDialog onCompleted={fetchRunners} />
      </PageHeader>
      <PageContent size="full">
        <RunnerOpsTable
          runners={runners}
          loading={loading}
          onScaleDown={(r) => setScaleDownTarget(r)}
          inProgressId={scaleDownTarget?.id ?? null}
        />
      </PageContent>
      <ScaleDownDialog
        runner={scaleDownTarget}
        open={!!scaleDownTarget}
        onOpenChange={(o) => { if (!o) setScaleDownTarget(null) }}
        onCompleted={() => { setScaleDownTarget(null); fetchRunners() }}
      />
    </PageLayout>
  )
}

export default RunnerOps
```

- [ ] **Step 2: Add the route in `App.tsx`**

Add the import:

```typescript
import RunnerOps from './pages/admin/RunnerOps'
import { RequireAdmin } from './components/auth/RequireAdmin'
```

Inside the existing `<Routes>` (next to other dashboard children):

```typescript
<Route
  path={getRouteSubPath(RoutePath.ADMIN_RUNNER_OPS)}
  element={<RequireAdmin><RunnerOps /></RequireAdmin>}
/>
```

- [ ] **Step 3: Locate the sidebar**

```bash
grep -rln "RoutePath.SANDBOXES" apps/dashboard/src --include="*.tsx" | grep -v __tests__ | head
```

Open the matching file. Find where the navigation items are listed (usually an array of objects with `to`/`label`).

- [ ] **Step 4: Add the sidebar entry**

Inside that file:

```typescript
import { useCurrentUser } from '@/hooks/useCurrentUser'
// ...
const { isPlatformAdmin } = useCurrentUser()
// ...inside the nav list rendering:
{isPlatformAdmin && (
  <NavLink to={RoutePath.ADMIN_RUNNER_OPS}>Runner Ops</NavLink>
)}
```

Match the existing NavLink/MenuItem styling. If the sidebar uses a config array, add a new entry guarded by `isPlatformAdmin`.

- [ ] **Step 5: Verify everything compiles**

```bash
cd apps && ./node_modules/.bin/tsc -p dashboard/tsconfig.app.json --noEmit
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/pages/admin/RunnerOps.tsx \
        apps/dashboard/src/App.tsx \
        $(grep -rln "RoutePath.SANDBOXES" apps/dashboard/src --include="*.tsx" | grep -v __tests__ | head -1)
git commit -m "feat(dashboard): admin Runner Ops page + route + sidebar entry"
```

---

## Task 17: End-to-end manual verification + runbook

**Files:**
- Create: `docs/runner-scaling/runner-ops-ui-runbook.md`
- Modify: `docs/runner-scaling/README.md`

- [ ] **Step 1: Run the full stack**

```bash
cd apps/infra-local && make up
cd apps && yarn nx serve api &
cd apps && yarn nx serve dashboard &
```

Confirm `api.boxlite.test` and `dashboard.boxlite.test` are reachable.

- [ ] **Step 2: Log in as the admin user**

Use the credentials from `~/.boxlite/admin-token` (or wherever the local infra exposes them).

- [ ] **Step 3: Walk the happy path**

1. Open `https://dashboard.boxlite.test/dashboard/admin/runner-ops`. Confirm the sidebar item is visible and you reach the page (not redirected).
2. Click **+ Add runner**, enter a name like `runner-ui-test-1`, submit. Watch lines stream.
3. Wait for the status `SUCCESS`. Verify a new EC2 instance exists (`aws ec2 describe-instances --filters Name=tag:Name,Values=runner-ui-test-1 --profile boxlite-ro`) and a new runner row exists (the list refreshes).
4. Open a sandbox creation flow from a different page; verify the new runner picks up workload.
5. Return to Runner Ops, click **Scale down** on `runner-ui-test-1`. Confirm the 10-stage progress appears.
6. Wait for `SUCCESS`. Verify the row disappears and the EC2 instance is `terminated`.

- [ ] **Step 4: Walk the unauthorized path**

Log out, log in as a non-admin user. Navigate to `/dashboard/admin/runner-ops`. Verify you are redirected to `/dashboard/sandboxes`.

- [ ] **Step 5: Write the runbook**

Create `docs/runner-scaling/runner-ops-ui-runbook.md` (English):

```markdown
# Runner Ops UI Runbook

## Audience

Platform operators with `SystemRole.ADMIN` in BoxLite Cloud.

## When to use this UI

- Capacity expansion: add a new SHARED runner without shelling into the build host.
- Capacity reduction: drain and decommission a SHARED runner with live progress visibility.

For CUSTOM (per-org) runners, use the existing `apps/infra/scripts/add-runner.ts` CLI.

## Add a shared runner

1. Open Dashboard → Runner Ops.
2. Click **+ Add runner**.
3. Optional: set name, region, instance type. Defaults are `runner-shared-<rand>`, `us`, `c8i.2xlarge`.
4. Click **Add runner**. The dialog now displays a live log.
5. Watch for `SUCCESS`. The runner takes 1–3 minutes to reach `READY`; the dialog only closes successfully once `READY` is reported.

If the status reaches `FAILED`, copy the log (everything in the gray box) into the incident channel and consult the troubleshooting section.

## Scale down a shared runner

1. From the Runner Ops table, click **Scale down** on the row.
2. Confirm the action.
3. Watch the 10-stage flow:
   ```
   [1/10] preflight
   [2/10] cordon source
   [3/10] enumerate sandboxes
   [4/10] stop STARTED sandboxes
   [5/10] backup all sandboxes
   [6/10] archive all
   [7/10] restart on peer
   [8/10] drain wait
   [9/10] delete runner row
   [10/10] terminate EC2
   ```
4. On `SUCCESS`, the row is gone from the table and the EC2 instance is terminated.

## Troubleshooting

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| 409 Conflict on Add | Another add job is already running | Wait for it to finish; refresh the page. |
| Status `FAILED` at preflight | Runner is not SHARED+READY, or no peer in same region | Verify region/state in the table; you cannot scale down if no peer accepts the boxes. |
| Status `FAILED` at `[5/10] backup` | Backup timed out (default 900s) | The source remains cordoned. Inspect the sandbox via the existing sandbox detail page, then re-run scale-down via the CLI with `--max-wait-backup 1800`. |
| Status `STALE` | API restarted mid-job | Check EC2 and apps/api state, manually clean up, then re-run. |
| Runner stuck in `INITIALIZING` for >5 min | EC2 user-data failed; runner cannot register | SSH into the EC2 (via `aws ssm start-session`); inspect `journalctl -u boxlite-runner`. |

## CLI escape hatches

Both operations remain available as CLIs:

```bash
cd apps/infra
BOXLITE_ADMIN_API_KEY=<token> AWS_PROFILE=<...> \
  npx tsx scripts/add-shared-runner.ts --name <...> --yes
BOXLITE_ADMIN_API_KEY=<token> AWS_PROFILE=<...> \
  npx tsx scripts/scale-down-runner.ts --id <runner-id> --yes
```

These exhibit identical behaviour to the UI flow and accept extra knobs (timeouts, dry-run, skip-terminate). Consult their `--help`.

## Audit trail

Every operation generates entries in the API's audit log (`AuditModule`). Job records live in Redis for 24 hours.

## Limitations (MVP)

- No autoscaling. Operators trigger every action.
- No CUSTOM runner UI. Use the CLI for per-org runners.
- One concurrent add + one concurrent scale-down across the platform.
- No SSE; UI polls every 2 s.
- Job records expire after 24 hours.
```

- [ ] **Step 6: Update `docs/runner-scaling/README.md`**

Add to the §1 index table:

```markdown
| **Runner Ops Admin UI** | [`docs/superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md`](../superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md) + [runbook](./runner-ops-ui-runbook.md) | Admin dashboard surface for add/scale-down |
```

- [ ] **Step 7: Update the spec status**

Edit the header of `docs/superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md`:

```markdown
**Status:** Implemented (PR #<...>)
```

(After the PR is merged. Until then, leave as Draft.)

- [ ] **Step 8: Commit**

```bash
git add docs/runner-scaling/runner-ops-ui-runbook.md \
        docs/runner-scaling/README.md \
        docs/superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md
git commit -m "docs(runner-ops): UI runbook + index"
```

- [ ] **Step 9: Open the PR**

```bash
git push -u origin feat/cloud-mvp-runner-auto-scaling
gh pr create --base main \
  --title "feat: Runner Ops admin UI (manual add + scale-down)" \
  --body "$(cat <<'EOF'
## Summary

- Adds an admin-only dashboard page `/dashboard/admin/runner-ops`
- Surfaces SHARED runners with state, score, sandbox count, capacity usage
- "+ Add runner" wraps the existing `add-shared-runner.ts` orchestration
- Per-row "Scale down" wraps the existing 10-stage `scale-down-runner.ts`
- Both operations expose live progress via Redis-backed jobs polled at 2 s

## Architecture

Scripts refactored into `async function*` libs in `apps/infra/lib/`. NestJS
service consumes the generators and persists progress. CLI scripts retained
as thin shells (byte-for-byte stderr output preserved).

## Test plan

- [x] `yarn nx test api` green
- [x] `yarn nx test dashboard` green
- [x] `apps/infra` jest suites green
- [x] CLI snapshot tests confirm no observable script change
- [x] Manual e2e in apps/infra-local: add → use → scale-down
- [x] Unauthorized redirect verified

Spec: `docs/superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md`
Runbook: `docs/runner-scaling/runner-ops-ui-runbook.md`
EOF
)"
```

---

## Self-Review Notes

Run these checks before declaring the plan complete and dispatching execution.

**Spec coverage** (cross-reference §18 of the spec):

- Prerequisites P1 → Task 1 ✓
- Prerequisites P2 → Task 1 (regen) ✓
- Prerequisites P3a → Task 2 ✓
- Prerequisites P3b → Task 2 ✓
- Lib types (1) → Task 3 ✓
- addSharedRunner lib (2) + CLI (4) → Task 4 ✓
- scaleDownRunner lib (3) + CLI (5) → Task 5 ✓
- RunnerOpsJobStore (6) → Task 7 ✓
- RunnerOpsService (7) → Task 8 ✓
- DTOs (8) → Task 9 ✓
- Controller + admin.module (9, 10) → Task 10 ✓
- api-client regen (11) → Task 11 ✓
- RunnerOps page + dialogs + table + hook + routing (12–18) → Tasks 12–16 ✓
- Tests (19–21) → embedded in each task ✓
- Docs (22) → Task 17 ✓

**Type consistency check:**

- `JobRecord` (Task 7) ↔ `JobDto` (Task 9): same fields except DTO swaps `Date` for `string` and uses class-validator. Aligned.
- `AddSharedRunnerOpts` / `ScaleDownOpts` (Task 3) ↔ Service input shapes (Task 8): the service constructs the lib opts from controller DTOs + config; field names match.
- `ProgressEvent` types only appear in Task 3 (defined) and Tasks 4/5/8 (consumed). All four event kinds (`stage`/`log`/`data`/`warning`) are handled in `applyEvent` (Task 8 Step 3).

**Open questions deferred:**

- Where the sidebar lives — discovered at runtime in Task 16 Step 3 via `grep`.
- Whether `useApi` already exposes `usersApi` — discovered at runtime in Task 2 Step 1.
- IAM additions — out of scope of this PR per spec §17.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-runner-ops-admin-ui.md`.**

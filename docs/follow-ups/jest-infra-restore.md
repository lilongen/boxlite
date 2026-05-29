# Follow-up: Restore Jest unit-test infrastructure

**Filed:** 2026-05-25
**Surfaced by:** Runner Ops work (during the dashboard-UI prototype, since dropped)
**Owner:** TBD
**Priority:** Medium — blocks proper TDD discipline for any new unit tests; manual e2e currently covers behavioural verification.

## Status update (2026-05-27) — largely resolved

The jest *infrastructure* is restored; what remains are individual spec-code bugs.

- **Root `tsconfig.base.json`** — now a tracked symlink → `apps/tsconfig.base.json`, so the TS5083 error is gone.
- **Root `jest.preset.js`** — restored (resolves `@nx/jest/preset` from `apps/node_modules`). `nx test api` no longer errors on the missing preset; self-contained specs run green (e.g. `snapshot-ref.util.spec.ts` 5/5, `runner-ops.service.spec.ts` 3/3).
- **`apps/infra` provider/lib tests** (Task 2/3/4/6 of the localprocess-provider plan) — were never green: `jest.config.cjs` left ts-jest on `module=commonjs` (no top-level `await`), an untyped mock inferred `never`, and two lib tests pushed a union into a `ProgressEvent[]`. Fixed (ESM+target pinned in `jest.config.cjs`; typed the aws send mock; asserted the narrowed yield type). **All 5 suites green (15 tests).**
- **`uuid` ESM transform** — jest ignored `node_modules`, so specs transitively importing `uuid` (ESM-only `dist-node`) failed to parse. Fixed with `transformIgnorePatterns: ['/node_modules/(?!uuid/)']` in `apps/api/jest.config.ts`.

**Resolved spec-code bugs (2026-05-27, second pass):**
- `runner-ops-job-store.spec.ts` — `getRedisToken` → `getRedisConnectionToken` (the actual `@nestjs-modules/ioredis` export). Green.
- `runner-ops.controller.spec.ts` — installed `supertest`/`@types/supertest` (devDeps) and switched to a default import (`import request from 'supertest'`; the v6 types export a namespace, not a callable). Green.
- `runner.service.spec.ts` — the mock runners lacked `createdAt`/`updatedAt`, so `findAllFull`'s `.toISOString()` mapper crashed; added the Date fixtures. Green.

All known apps/api runner-ops + runner.service + snapshot-ref specs now pass. No outstanding jest issues for the runner-ops work.

## Symptom

```
$ yarn nx test api --testPathPatterns user.dto.spec --runInBand
> jest --passWithNoTests=true --testPathPatterns user.dto.spec --runInBand

Error: Jest: Failed to parse the TypeScript config file apps/api/jest.config.ts
  TSError: ⨯ Unable to compile TypeScript:
error TS5083: Cannot read file '/.../boxlite-cloud-mvp-runner-auto-scaling/tsconfig.base.json'.
```

Same error for any other `nx test` target inside `apps/`.

## Root cause

Commit `4c41ace7 revert: drop root jest.preset.js + tsconfig.base.json` deliberately removed two root files that had been blind-copied from upstream `daytonaio/daytona`. Quoting that commit:

> BoxLite's sub-project tsconfigs reference `extends: "../../tsconfig.base.json"` (root) when the actual base config lives at `apps/tsconfig.base.json` (one-up). Fixing that needs its own small PR — either move the file or fix the relative paths uniformly.

So today:
- `apps/api/jest.config.ts` line 9: `preset: '../../jest.preset.js'` — resolves to a missing file.
- `apps/api/tsconfig.spec.json` (and siblings) extend from `../../tsconfig.base.json` — also missing at that path.
- The actual base lives at `apps/tsconfig.base.json` (one level less).

## Fix options

### Option A: Move base files to repo root with correct content (recommended)

Promote `apps/tsconfig.base.json` to `tsconfig.base.json` at the workspace root (keeping its correct `@boxlite-ai/*` aliases — do NOT use upstream's `@daytona/*`). Create a fresh `jest.preset.js` at the root that follows the NX preset pattern for this workspace's package set. Update `apps/tsconfig.json` (and any other consumers) to point at the new root paths. Verify a single existing spec runs:

```bash
yarn nx test api --testPathPatterns snapshot-ref
```

### Option B: Adjust every sub-project's relative path

Change `extends` paths in every `apps/*/tsconfig*.json` from `../../tsconfig.base.json` to `../tsconfig.base.json`, and equivalent for jest configs. Touch more files but no relocation.

Option A is fewer downstream edits and matches NX conventions; Option B preserves the current layout of base config inside `apps/`.

## Related: api-client OpenAPI regen is also broken

```
$ yarn nx run api-client:generate:api-client
> yarn ts-node apps/api/src/generate-openapi.ts -o dist/apps/api/openapi.json
Error: ENOENT: no such file or directory, lstat 'apps/api/tsconfig.app.json'
```

Same root cause: when nx runs the generator from the apps/ workspace root, it
tries `apps/api/tsconfig.app.json` (relative to cwd) which resolves to
`apps/apps/api/tsconfig.app.json` and fails. The fix is either to make the
generator path-independent or to fix the cwd ts-node uses. Either approach is
the same scope as fixing `tsconfig.base.json` placement (Option A above).

While unresolved, downstream consumers of the api-client must:
- Use local stub types (string unions) for new server-side enums/DTOs, or
- Import from `@boxlite-ai/api-client` only when the type already exists pre-this-PR.

## Related: dashboard `tsc` cannot type-check (same root cause)

`apps/dashboard/tsconfig.json` extends `../../tsconfig.base.json` (repo root,
missing — actual base is `apps/tsconfig.base.json`). Unlike `apps/api` (which
emits the TS5083 then continues with default options), the dashboard falls back
to `moduleResolution: classic`, which cannot resolve the `@/*` path aliases —
so `tsc -p dashboard/tsconfig.app.json --noEmit` fails outright (TS5083 +
TS5070) and never type-checks dashboard source. Net effect: **dashboard
TypeScript is unverifiable on this branch** until the base-config placement is
fixed (Option A above). This is the third symptom of the same root cause
(jest preset, api-client regen, dashboard tsc).

## Impact while unresolved

Unit tests written via Jest cannot execute. The following PRs/work merged a `*.spec.ts` file that is currently not exercised in CI:

- `feat(api): expose SystemRole on UserDto` (`b2be375d`) — `apps/api/src/user/dto/__tests__/user.dto.spec.ts` (well-formed, awaiting jest restore)

## Recommended next step

1. One ~half-day PR titled `chore(jest): restore root jest.preset.js + tsconfig.base.json with @boxlite-ai aliases`.
2. Add a smoke CI step: `yarn nx test api --testPathPatterns snapshot-ref` must succeed.
3. After merge, retroactively run the queued unit tests from the Runner Ops PR and address any genuine failures.

# apps/local-dev

Local infra for **verifying the alpine:3.22.4 sandbox-create fix** without touching
the cloud dev environment.

## What this is

- `docker-compose.local.yml` — Postgres + Redis + a mock runner.
- `mock-runner/server.mjs` — ~120-line Node HTTP stub that satisfies the
  `runner-api-client` endpoints the API hits during snapshot pull. Returns
  **501 on `/snapshots/build`** to prove that any code path still routing to
  build will fail loudly — not silently with a 60s timeout.
- `smoke.sh` — six-check end-to-end of the local stack.

## What this is **not**

Booting the full NestJS API locally needs auth (OIDC), an internal Docker
registry, S3/MinIO, and ~30 env vars — it's a multi-hour setup, not 5 minutes.
This local-dev directory only stands up the dependencies the API would talk
to. The API itself is verified by:

1. **Unit tests** (`apps/api/src/sandbox/utils/dockerfile.util.spec.ts`) — 17
   tests for `parseDockerfileForSingleFromRef`.
2. **Type checking** (`tsc --noEmit`) — zero errors in the four files we
   touched.
3. **SDK fix** (`apps/libs/sdk-typescript/src/Sandbox.ts:373`) — verified with a
   standalone Node test harness; `build_failed` now terminates `waitUntilStarted`
   immediately instead of timing out after 60s.
4. **Cloud smoke** — push the branch, deploy to `dev.boxlite.ai`, create a
   sandbox from `alpine:3.22.4` in the dashboard, watch it reach `started`.

## Quick start

```bash
# 1) Bring up pg + redis + mock-runner (~5s on warm cache)
docker compose -f apps/local-dev/docker-compose.local.yml up -d

# 2) Run smoke checks
apps/local-dev/smoke.sh

# 3) Tear down (-v drops the volumes too)
docker compose -f apps/local-dev/docker-compose.local.yml down -v
```

## What `smoke.sh` verifies

| # | Check | Why it matters |
|---|-------|----------------|
| 1 | All three containers healthy | Stack came up |
| 2 | `POST /snapshots/build` → **501** | If the API ever reaches build for `FROM <ref>`, the failure is visible — not a 60s hang |
| 3 | `POST /snapshots/inspect` returns a digest | The path `snapshot.manager.handleSnapshotStatePending` takes is reachable |
| 4 | `POST /snapshots/pull` → 202 | The pull path the fix routes to works |
| 5 | Postgres round-trip | DB ready for TypeORM migrations |
| 6 | Redis round-trip | `RedisLockProvider` will work |

## If you also want to boot the API locally

The blockers (in order of cost):
- **Auth bypass.** The dashboard endpoints require either an OIDC JWT (needs
  Dex) or a hashed API key from the DB (needs admin user seeded via
  `app.service.ts::initializeAdmin`). Set `ADMIN_API_KEY=<some-key>` and let the
  app seed itself on first boot.
- **Registries.** `transientRegistry.*` and `internalRegistry.*` are
  `getOrThrow()` lookups in `configuration.ts`. You'd need to stand up a
  Distribution registry container and seed `DockerRegistry` rows.
- **Default region + snapshot.** Same — `getOrThrow('defaultRegion.id')` and
  `defaultSnapshot`. Need fixture rows after migrations.
- **OTel + ClickHouse.** Set `OTEL_ENABLED=false` to skip.

That's the path to a full local API; if you want me to script it next, say so.

## Connecting components

```
DB_HOST=localhost  DB_PORT=5432  DB_USERNAME=boxlite  DB_PASSWORD=boxlite  DB_DATABASE=boxlite
REDIS_HOST=localhost  REDIS_PORT=6379
# Runner URL the API would dial:
http://localhost:3003
```

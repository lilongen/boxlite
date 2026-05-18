# apps/local-dev — BoxLite control plane on macOS

A docker-compose stack that runs the BoxLite control plane end-to-end on
**macOS (Apple Silicon)**. Designed for the path: clone repo → bring stack
up → exercise the dashboard / API → optionally attach a host-native runner.

> **Scope.** This directory replaces the cloud SST deployment for local
> development. It is **not** a production deployment recipe — secrets are
> hard-coded, TLS is disabled, S3 is MinIO, the docker registry is anonymous,
> etc.

---

## What runs

| # | Service | Image / Build | Host port | Role |
|---|---------|---------------|-----------|------|
| 1 | postgres | `postgres:16-alpine` | 5432 | State |
| 2 | redis | `redis:7-alpine` | 6379 | Locks + cache |
| 3 | dex | `apps/dex/Dockerfile` | 5556 | OIDC IdP — default user `admin@boxlite.dev` / `password` |
| 4 | minio | `minio/minio` | 9000 / 9001 | S3 + console UI |
| 5 | minio-init | `minio/mc` | — | One-shot bucket bootstrap |
| 6 | registry | `registry:2` | **5050** (5000 collides with AirPlay) | Docker Distribution v2 — plays the snapshot-manager role |
| 7 | api | `apps/api/Dockerfile` | 3000 | NestJS control plane |
| 8 | mock-runner | inline Node stub | 3003 | Default runner; replaced by host-native runner later |
| 9 | snapshot-manager *(profile: full)* | `apps/snapshot-manager/Dockerfile` | 5001 | For parity with cloud |
| 10 | proxy *(profile: full)* | `apps/proxy/Dockerfile` | 4000 | Sandbox HTTP-preview |
| 11 | ssh-gateway *(profile: full)* | `apps/ssh-gateway/Dockerfile` | 2222 | Sandbox SSH |

The **dashboard** runs separately on the host (`yarn nx serve dashboard`,
`localhost:5173`) so frontend hot-reload works.

The **runner** runs natively on the Mac host (Hypervisor.framework + libkrun);
the compose stack only includes a mock runner. Native runner build
instructions are below.

---

## Prereqs

- Docker Desktop for Mac, Apple Silicon build, recent (≥ 4.30).
- Node.js 22 + Yarn 4 (via Corepack: `corepack enable`).
- ~6 GB free disk for images + volumes.
- Mac M1/M2/M3/M4/M5 (Apple Silicon). Intel Macs work for the docker stack
  but the native runner story is much weaker on HVF.

---

## Quick start

```bash
# 1) One-time prep — generates apps/yarn.lock and copies .env.example to .env.
./apps/local-dev/setup.sh

# 2) Bring the stack up (first run builds the API image; ~5-15 min).
docker compose -f apps/local-dev/docker-compose.local.yml \
  --env-file apps/local-dev/.env up -d

# 3) Watch services come healthy.
docker compose -f apps/local-dev/docker-compose.local.yml ps

# 4) Tail the API log until you see "Admin user created with API key: <key>".
docker compose -f apps/local-dev/docker-compose.local.yml logs -f api

# 5) Smoke (six checks).
./apps/local-dev/smoke.sh

# Tear down (-v removes volumes; data is then truly gone).
docker compose -f apps/local-dev/docker-compose.local.yml down -v
```

The API key it logs is whatever you set in `.env::ADMIN_API_KEY` (default
`local-dev-admin-key-do-not-deploy`). All subsequent admin curls use it.

### Optional: full profile

```bash
docker compose -f apps/local-dev/docker-compose.local.yml \
  --env-file apps/local-dev/.env --profile full up -d
```
Adds `snapshot-manager` (port 5001), `proxy` (4000), `ssh-gateway` (2222).
None are strictly required for the API to boot.

---

## URLs you'll need

| Service | URL |
|---------|-----|
| API | `http://localhost:3000` (health: `/api/config`) |
| Dex auth flow | `http://localhost:5556/dex` |
| MinIO Console | `http://localhost:9001` — user `boxlite-local` / `boxlite-local-secret` |
| Docker Registry catalog | `http://localhost:5050/v2/_catalog` |
| Dashboard (host) | `http://localhost:5173` after `yarn nx serve dashboard` |

---

## OIDC localhost ↔ container split

The API container talks to Dex via `http://dex:5556/dex` (compose DNS), but the
browser must reach Dex via `http://localhost:5556/dex` (only `localhost` is
reachable from your Mac's browser). Both must agree on the issuer claim
embedded in the JWT.

The API code handles this directly:

```ts
// apps/api/src/auth/auth.module.ts:48
if (publicIssuer) {
  jwksUri = metadata.jwks_uri.replace(publicIssuer, internalIssuer)
}
```

So `.env` sets:

- `PUBLIC_OIDC_DOMAIN=http://localhost:5556/dex` — what the browser sees and
  what's encoded in the JWT `iss` claim.
- `OIDC_ISSUER_BASE_URL=http://dex:5556/dex` — what the API uses internally
  to fetch the discovery doc / JWKS.

No `/etc/hosts` edits, no host networking, no SSH tunneling.

---

## Smoke checks (`./apps/local-dev/smoke.sh`)

Six probes that should all pass once everything is up:

1. All containers `healthy`.
2. mock-runner `POST /snapshots/build` returns **501** (proves the stub-build
   path would fail visibly if the API ever routed to it).
3. mock-runner `POST /snapshots/inspect` returns a digest.
4. mock-runner `POST /snapshots/pull` returns 202.
5. Postgres write+read round-trip.
6. Redis SET/GET round-trip.

---

## What still needs you to do something (Tier 2 path)

### A. Run the dashboard (~1 min)

```bash
cd apps && yarn nx serve dashboard
# → http://localhost:5173
```
Log in with `admin@boxlite.dev` / `password` via the Dex auth flow.

### B. Build the host-native runner (~30-60 min first time)

The runner needs libkrun.dylib built against Hypervisor.framework. Steps:

```bash
# 0) Init the libkrun submodule if not already.
git submodule update --init --recursive src/deps/libkrun-sys/vendor/libkrun

# 1) Build the Rust runtime + Go SDK glue (uses HVF on Apple Silicon).
make build-runtime   # or whatever target boots the .dylib for darwin/arm64

# 2) Build the apps/runner Go binary against the SDK.
cd apps/runner && go build -o bin/runner ./cmd/runner

# 3) Run with config pointing at the local API.
./bin/runner \
  --api-url=http://localhost:3000 \
  --api-key=$DEFAULT_RUNNER_API_KEY \
  --listen=:3003
```

> 🛠 **Not yet scripted.** The exact Makefile targets / build commands depend
> on your local toolchain (Rust nightly, Xcode CLT, etc.). The
> docker-compose stack already routes the API to `host.docker.internal:3003`
> via `extra_hosts`, so once your native runner is up it just works.

### C. Register the runner with the API

The API auto-creates a `DefaultRunner` row pointing at the URLs in `.env`.
Confirm:

```bash
curl -s http://localhost:3000/api/runner \
  -H "Authorization: Bearer $ADMIN_API_KEY" | jq
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `failed to compute cache key: "/apps/yarn.lock": not found` | yarn.lock was never generated | Run `./apps/local-dev/setup.sh` |
| API container stuck restarting | Migrations failed | `docker compose logs api` — look for the SQL error |
| Dashboard login redirects loop | Issuer mismatch | Make sure browser URL is `localhost:5173` not `127.0.0.1:5173` (cookie domain) |
| `port 5000 already in use` | macOS AirPlay Receiver | Already mitigated: registry publishes on 5050 |
| `host.docker.internal` not resolving in api | Old Docker Desktop | Update Docker Desktop to ≥ 4.30 |

---

## Files

```
apps/local-dev/
├── README.md                     ← this file
├── setup.sh                      ← one-time prep
├── smoke.sh                      ← six-check smoke
├── docker-compose.local.yml      ← the stack definition
├── .env.example                  ← copy to .env and tweak
├── minio/
│   └── init.sh                   ← bucket bootstrap
└── mock-runner/
    └── server.mjs                ← runner stub (replaced by host-native runner later)
```

---

## Status of each layer

| Layer | Works on fresh M-series macOS? | Notes |
|---|---|---|
| Postgres + Redis + Dex + MinIO + Registry + mock-runner | ✅ verified | All healthy in ~10s |
| API container (`--profile api`) | ❌ blocked | Upstream main has ~35 TS strict-mode errors in audit/req.headers code that the production build (`yarn nx build api`) trips on. Fixing them is out of scope for local-dev tooling. Track separately. |
| API on host (`yarn nx serve api`) | ❌ blocked | The Nx workspace root is `apps/`, but `apps/api/project.json` paths use `apps/` prefix (e.g. `"webpackConfig": "apps/api/webpack.config.js"`). This works in Docker because Dockerfile sets `WORKDIR /boxlite` and `COPY apps/api/ apps/api/`, but breaks on host where the workspace root **is** `apps/`. Symlink workarounds confuse nx's project graph (`create-package-json.js:165` undefined data). The fix is either re-rooting the workspace one level up, or rewriting project.json paths + Dockerfile in tandem. |
| snapshot-manager / proxy / ssh-gateway (Go) containers | 🟨 untested | They share the API's Dockerfile-style nx-build dependency. Likely hits the same TS error since the build step compiles the whole workspace. Use `--profile full` to attempt. |
| Native host runner (libkrun + HVF) | 🟨 future batch | The compose stack already points the API at `host.docker.internal:3003` via `extra_hosts`, so once the native runner is built and bound to `:3003` it just works. Build pathway needs scripting (Rust runtime → libkrun.dylib → apps/runner Go binary). |
| Dashboard (host: `yarn nx serve dashboard`) | 🟨 likely same nx issue | Frontend has the same project.json path mismatch. |

## Recommended next moves

The simplest unblock for "full local control plane" is one of:

1. **Fix upstream main** — open a PR addressing the 35 TS strict-mode errors
   in the controllers (cast `req.headers[x]` / `req.params[x]` to `string`)
   AND clean up the nx workspace layout (move `nx.json` + `package.json` to
   repo root, or update project.json paths to be relative to `apps/`).

2. **Continue cloud-only API testing** — let `sst deploy --stage dev` keep
   carrying the API, while local dev only exercises the infra contract
   (mock runner, manual SQL inspection, custom NestJS unit tests).

This stack is genuinely useful for either: it gives you a real Postgres /
Dex / MinIO / Registry to point a separately-running API at, with no
cloud-dependency for state.

## Roadmap

- ✅ Postgres + Redis + Dex + MinIO + Registry + mock-runner.
- ✅ `--profile full` opts in snapshot-manager / proxy / ssh-gateway
  containers (untested due to shared API build dependency).
- ⏳ Upstream main TS strict-mode fix — out of scope here, blocks API build.
- ⏳ Nx workspace re-rooting — out of scope here, blocks host API serve.
- ⏳ Native runner build script (`make runner:macos` target).
- ⏳ Dashboard dockerization (alternative to host dev server).
- ⏳ OTel Collector + Jaeger UI for tracing.
- ⏳ Mac sandbox e2e: create `alpine:3.22.4` sandbox → boot HVF VM → exec.

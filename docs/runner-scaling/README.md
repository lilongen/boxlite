# Runner Scaling — scripts & docs index

Everything for **manual add-runner / scale-down-runner** in BoxLite Cloud MVP.
Scope of this work (constraints):

1. **Manual / explicit triggers** — no autoscaler decision-making.
2. **SHARED-region, in-region migration only** — boxes move between SHARED
   runners in the same region.
3. **No SQL surgery** — everything flows through the `apps/api` REST surface.
4. **One abstraction over dev and prod** — the same orchestration drives a local
   process (dev) and real EC2 (prod) via `IInfraProvider`.

Start with **[runner-scale-design.md](./runner-scale-design.md)** — the authoritative
design (architecture, the 7-stage add + 10-stage scale-down flows, providers,
backup data flow, Daytona comparison, and the layers that make a runner
backup-capable).

## Scripts

| Use case | Script | One-liner |
|---|---|---|
| Add a SHARED runner | [`add-shared-runner-dev.sh`](../../apps/infra/scripts/add-shared-runner-dev.sh) | wrapper: discover subnet/IAM + call `add-shared-runner.ts` |
| └ underlying | [`add-shared-runner.ts`](../../apps/infra/scripts/add-shared-runner.ts) | `POST /api/admin/runners` + provider `provisionRunner` (EC2 / local) |
| Add a CUSTOM runner (org-scoped) | [`add-runner.ts`](../../apps/infra/scripts/add-runner.ts) (+ `add-runner-dev.sh`) | create CUSTOM region + `POST /api/runners` + provision host |
| Scale down a SHARED runner | [`scale-down-runner.ts`](../../apps/infra/scripts/scale-down-runner.ts) | 10-stage: cordon → stop → backup → archive → restart on peer → DELETE row → terminate host |
| Prepare the scale-down E2E env | [`test-setup-scale-down.ts`](../../apps/infra/scripts/test-setup-scale-down.ts) | place sandboxes on r1/r2 via cordon-steering + seed snapshot rows |
| Deploy a from-source runner to a test EC2 | [`deploy-patched-scaledown-binaries.sh`](../../scripts/deploy/deploy-patched-scaledown-binaries.sh) | S3 presign + SSM (dev only; prod pulls from GitHub Release) |

Shared module: [`runner-user-data.ts`](../../apps/infra/lib/runner-user-data.ts) —
EC2 user-data builder. Sets `BOXLITE_BACKUPS_BUCKET` (backup is always-on; no
sidecar), installs the `boxlite` CLI, and honors `BOXLITE_RUNNER_RELEASE_REPO` /
`BOXLITE_RUNNER_VERSION` overrides.

## Design & reports

| Doc | What |
|---|---|
| [runner-scale-design.md](./runner-scale-design.md) | **Authoritative design** (read this first) |
| [runner-ops-api-runbook.md](./runner-ops-api-runbook.md) | curl runbook for the server-side runner-ops API (add / scale-down via HTTP) |
| [local-scale-down-e2e-2026-05-27.md](./local-scale-down-e2e-2026-05-27.md) | local provider add/scale-down/migration E2E (macOS) |
| [aws-scale-down-e2e-2026-05-27.md](./aws-scale-down-e2e-2026-05-27.md) | real-AWS provision/terminate + empty-runner scale-down |
| [aws-migration-e2e-2026-05-28.md](./aws-migration-e2e-2026-05-28.md) | real-AWS scale-down **with live box migration** (CLI path) |
| [api-endpoint-e2e-2026-05-28.md](./api-endpoint-e2e-2026-05-28.md) | add + scale-down **via the runner-ops API endpoints** (incl. B-tier migration) |

Related follow-ups: [released runner lacks backup](../follow-ups/runner-backup-not-in-released-runner.md),
[migration bystander recreate race](../follow-ups/runner-migration-bystander-recreate-race.md),
[ListInfo CGO crash](../follow-ups/runner-listinfo-cgo-crash.md).

## Quick start

```bash
cd apps/infra
export AWS_PROFILE=<profile> BOXLITE_ADMIN_API_KEY='<admin token>'

# add a SHARED runner (auto-discovers subnet/IAM/registry/backups bucket)
./scripts/add-shared-runner-dev.sh --region-id us --name runner-shared-001 --yes

# scale one down (migrates its live boxes to a peer, then terminates the host)
BOXLITE_API_URL=https://api.dev.boxlite.ai npx tsx scripts/scale-down-runner.ts --id <runner-uuid> --yes
```

Key scale-down flags: `--restart-stopped` (also migrate STOPPED boxes),
`--skip-terminate` (keep the EC2), `--dry-run` (preflight only),
`--max-wait-{backup,stop,archive,start} <s>` (per-stage timeouts). See
[runner-scale-design.md §5](./runner-scale-design.md) for the full flow.

## Status

local + AWS add/scale-down/migration validated; full migration proven via both
the CLI path and the runner-ops API endpoints. Known constraints (released runner
backup binary, random in-region scheduler, ListInfo CGO crash) are tracked in
[runner-scale-design.md §8](./runner-scale-design.md) and the follow-ups above.

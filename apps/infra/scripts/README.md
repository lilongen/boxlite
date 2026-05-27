# `add-runner` script

Adds one org-dedicated runner: creates a CUSTOM region (if needed), creates a
runner row via `POST /api/runners`, launches an EC2 with the returned `apiKey`,
waits for the runner to heartbeat to `READY`.

**Pure REST + EC2 SDK.** No DB tunnel, no SSM, no Pulumi outputs required.

> Trade-off vs the older DB-direct approach: **SHARED runners are NOT supported.**
> The REST endpoint only creates CUSTOM regions for orgs. If you need to add
> capacity to the default SHARED region, use a different mechanism (direct DB
> insert or the `apps/api` boot-time `initializeDefaultRunner` flow).

**Single self-contained file:** [`add-runner.ts`](add-runner.ts). All helpers
(region resolver, runner create, EC2 launch, result writer, API client) are
inlined. Only outside import: `buildRunnerUserData` from
[`../lib/runner-user-data.ts`](../lib/runner-user-data.ts), shared with
`sst.config.ts`.

---

## What it does

```
                        ┌────────────────────────────────────────┐
                        │  add-runner.ts (7 stages)              │
                        │                                        │
                        │  1. resolve region via REST            │──► POST /api/regions
                        │       (find-or-create CUSTOM)          │     (or GET if exists)
                        │  2. POST /api/runners                  │──► returns {id, apiKey}
                        │  3. build user-data                    │
                        │  4. EC2 RunInstances                   │──► aws-sdk
                        │  5. write result file (apiKey here)    │
                        │  6. (optional) wait                    │
                        │  7. poll GET /api/runners/:id          │──► REST
                        └────────────────────────────────────────┘
```

---

## Prerequisites

1. **Node 20+** + `yarn install` in `apps/infra/`
2. **AWS credentials** for EC2 RunInstances (via `AWS_PROFILE` env or `--aws-profile`)
3. **`BOXLITE_API_TOKEN`** — bearer token with:
   - `WRITE_REGIONS` and `WRITE_RUNNERS` permissions on the target org
   - The org must have `ORGANIZATION_INFRASTRUCTURE` feature flag enabled
4. **`BOXLITE_STAGE`** env var (intent guard, e.g. `dev`)

---

## Run

### Quickstart with the wrapper

```bash
cd apps/infra
export AWS_PROFILE=michaelli
export BOXLITE_API_TOKEN=<token-with-WRITE_REGIONS+WRITE_RUNNERS>
export BOXLITE_STAGE=dev

# Add a runner for org <uuid>:
./scripts/add-runner-dev.sh --orgid <uuid> --yes

# Dry-run (no API calls, no EC2):
./scripts/add-runner-dev.sh --orgid <uuid> --dry-run
```

The wrapper discovers `--subnet-id` and `--instance-profile-name` from the
existing `boxlite-runner` EC2 (so the new runner ends up in the same VPC/SG),
and derives `BOXLITE_API_URL` / `BOXLITE_REGISTRY_URL` from `STACK_DOMAIN`
(defaults to `dev.boxlite.ai`).

Override defaults via env: `AWS_REGION`, `BOXLITE_STAGE`, `STACK_DOMAIN`, `RUNNER_TAG_NAME`.

### Calling `add-runner.ts` directly

```bash
cd apps/infra
export BOXLITE_STAGE=dev

npx tsx scripts/add-runner.ts \
  --orgid <uuid> \
  --api-token <token> \
  --api-url https://api.dev.boxlite.ai \
  --registry-url https://snapshot-manager.dev.boxlite.ai \
  --subnet-id subnet-abc... \
  --instance-profile-name boxlite-RunnerProfile-xyz \
  --yes
```

All flags can also come from env: `BOXLITE_API_TOKEN`, `BOXLITE_API_URL`, `BOXLITE_REGISTRY_URL`.

---

## Result file

After a successful (or partially successful) run, `./add-runner-result.json`:

```json
{
  "schema_version": 2,
  "status": "READY",
  "runner": { "id": "...", "name": "runner-abc123", "apiKey": "dtn_...", "regionId": "..." },
  "region": { "id": "...", "name": "us", "organizationId": "...", "type": "custom", "createdByThisScript": true },
  "ec2": { "instanceId": "i-...", "instanceType": "c8i.2xlarge", "publicIp": "...", "privateIp": "...", "availabilityZone": "...", "launchedAt": "..." },
  "timing": { "startedAt": "...", "regionAt": "...", "runnerAt": "...", "ec2At": "...", "readyAt": "..." },
  "errors": [],
  "next_steps": "..."
}
```

File mode `0600`. The `apiKey` appears here ONCE — copy to your secret store
if you'll need it later (there's no API to fetch it back).

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Runner READY (or `--no-wait` and all stages succeeded) |
| 1 | Timeout waiting for READY (EC2 + DB row exist; investigate via SSM) |
| 2 | Pre-flight failure (no side effects) |
| 3 | REST API error (auth, feature flag, permission, validation) |
| 4 | EC2 launch failure (DB row orphan — manual cleanup needed via `DELETE /api/runners/:id`) |
| 5 | Invalid CLI args |
| 6 | Refused (no `BOXLITE_STAGE`, or user declined the confirmation) |

---

## After it runs

```bash
# Verify via REST:
curl https://api.dev.boxlite.ai/api/runners/<id> \
  -H "Authorization: Bearer $BOXLITE_API_TOKEN" \
  -H "X-Organization-Id: <orgid>"

# Or SSM into the host:
aws ec2 describe-instances --filters Name=tag:RunnerId,Values=<id>
aws ssm start-session --target <instance-id>
sudo journalctl -u boxlite-runner -n 200
```

### Routing sandboxes to this runner

The runner sits in a CUSTOM region. Sandboxes only schedule there if either:

1. **Per-request**: pass `"target": "<region-id>"` when calling `POST /api/sandboxes`.
2. **Per-org default**: update the org's `personalOrganizationDefaultRegionId`
   (no REST endpoint — direct DB or admin script).

---

## Cleanup

```bash
# 1. Drain
curl -X PATCH https://api.dev.boxlite.ai/api/runners/<id>/draining \
  -H "Authorization: Bearer $BOXLITE_API_TOKEN" \
  -H "X-Organization-Id: <orgid>" -d '{"draining":true}'

# 2. Wait for in-flight sandboxes to finish

# 3. Delete the DB row
curl -X DELETE https://api.dev.boxlite.ai/api/runners/<id> \
  -H "Authorization: Bearer $BOXLITE_API_TOKEN" \
  -H "X-Organization-Id: <orgid>"

# 4. Terminate the EC2
aws ec2 terminate-instances --instance-ids <i-...>
```

---

## Known limitations

- **No SHARED runner support.** REST `POST /api/runners` rejects non-CUSTOM regions. If you need to add SHARED capacity, the only path today is direct DB INSERT (deliberately not in this script anymore).
- **`ORGANIZATION_INFRASTRUCTURE` feature flag must be enabled** for the target org. The script will 403 otherwise with a hint.
- **EC2s are not tracked by Pulumi.** `pulumi destroy` won't clean them up. Tag-based discovery: `Name=tag:BoxliteOwner,Values=add-runner-script`.
- **No `--remove` mode.** Use the manual cleanup steps above.
- **Hardcoded `AWS_REGION=ap-southeast-1`.** Override via env if needed.

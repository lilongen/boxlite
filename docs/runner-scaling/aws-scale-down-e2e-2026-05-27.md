# AWS Scale-Down E2E (provider=aws, real EC2 on dev.boxlite.ai) — 2026-05-27

Live validation that the `IInfraProvider` refactor (the localprocess-provider
plan, Tasks 1–9) did **not** regress the production AWS path. The refactor rewired
`add-shared-runner.ts` / `scale-down-runner.ts` to go through `AwsInfraProvider`;
this run exercises that path against the **real dev.boxlite.ai AWS account**
(`ap-southeast-1`, account `064212132677`).

## Result: PASS

Added a throwaway SHARED runner via the wrapper, watched it reach READY on a real
EC2, then scaled it down and confirmed the row + instance were removed.

| Step | Result |
| --- | --- |
| `provisionRunner` → RunInstances (nested-virt + `RunnerId` tag) | ✅ EC2 `i-0a735d39d67a4eb80` launched |
| runner boots from user-data (v0.9.5 binary, systemd) → heartbeat | ✅ **READY in ~1 min** (`c8i.large`) |
| scale-down 10-stage orchestration (empty runner) | ✅ cordon → enumerate 0 boxes → delete row → terminate host |
| `terminateRunner` → TerminateInstances by `tag:RunnerId` | ✅ EC2 → `shutting-down` |
| runner row removed | ✅ `GET /admin/runners/:id` → 404 |
| no leftover instances (cost check) | ✅ only the terminating one, no others |
| scale-down `--dry-run` preflight + peer check (#3 fix) | ✅ 1 peer found, no side effects |

`runnerId=93245be6-b9f2-42d4-9b69-5d407bcc7b7e`, `instanceType=c8i.large`,
`subnet-0fdf9e1fd142ac7cc`, `instance-profile RunnerProfile-434704b` (mirrored
from the existing `boxlite-runner` EC2 by `add-shared-runner-dev.sh`).

## What this proves about the refactor

The refactored CLI → `buildProvider(args)` → `AwsInfraProvider.provisionRunner` /
`.terminateRunner` path is correct against real EC2:
- `provisionRunner` issues `RunInstances` with the right AMI (Ubuntu Noble
  x86_64), tags (`RunnerId`/`BoxliteOwner`/`BoxliteRegion`/`BoxliteStack`),
  IAM profile, subnet, public IP, and `CpuOptions.NestedVirtualization=enabled`.
- `terminateRunner` finds the instance by `tag:RunnerId` and terminates it.
- The scale-down lib's 10-stage flow runs on real infra; the #3 no-peer
  assertion + dry-run preflight behave as designed.

## Findings

### A. Runner instance type MUST support AWS nested virtualization
`AwsInfraProvider.provisionRunner` sets `CpuOptions: { NestedVirtualization:
'enabled' }` ([aws.ts](../../apps/infra/lib/infra-provider/aws.ts)) — the runner
needs `/dev/kvm` for libkrun. So an arbitrary "small" type fails:

```
--instance-type t3.medium →
InvalidParameterCombination: The specified instance type does not support Nested Virtualization.
```

The default is `c8i.2xlarge` (8 vCPU). **`c8i.large` (2 vCPU, ~¼ the cost) is
the cheapest validated nested-virt type** and reaches READY fine for an
empty-runner add/scale-down test. Validate a candidate type cheaply without
creating runner rows via:
`aws ec2 run-instances --dry-run --instance-type <t> --cpu-options NestedVirtualization=enabled --image-id <ami> --subnet-id <s> --iam-instance-profile Name=<p>`.

> Failure mode note: a `RunInstances` rejection happens **after** the runner row
> is created (stage 3) but **before** any EC2 launch, leaving a dangling runner
> row (no instance). Clean it up with cordon + `DELETE /api/admin/runners/:id`.

### B. The dev ADMIN token is NOT in Secrets Manager
`add-shared-runner-dev.sh` claims the admin key is "in AWS Secrets Manager as
'AdminApiKey'". It is not — SST defines it as a `random` value
(`adminApiKey = randomKey("AdminApiKey")`, sst.config.ts:153) injected as the
**Api ECS service's `ADMIN_API_KEY` env** (sst.config.ts:327). Retrieve it from
the running task definition:

```bash
TD=$(aws ecs describe-services --cluster boxlite-dev-ClusterCluster-vmauahcx --services Api \
      --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --task-definition "$TD" \
  --query "taskDefinition.containerDefinitions[].environment[?name=='ADMIN_API_KEY'].value" --output text
```

(The wrapper's comment should be corrected.)

### C. `--dry-run` on add is shallow
`add-shared-runner.ts --dry-run` exits **before** `buildProvider`, so it only
smoke-tests the CLI shell + the wrapper's AWS discovery — not the provider or the
admin-token API verify. Meaningful provider validation requires a real add
(Phase 2). The scale-down `--dry-run`, by contrast, does run the API preflight
(peer check).

## Not covered

- **Box migration on real AWS** (a started box on the source runner →
  backup→archive→restore on a peer). The empty-runner scale-down validates the
  provision/terminate + orchestration; box migration is already proven on the
  local provider (see [local-scale-down-e2e-2026-05-27.md](./local-scale-down-e2e-2026-05-27.md)).
  A full real-AWS migration test needs a KVM-capable runner with a placed box and
  would touch the shared dev scheduler — defer to a dedicated window.

## Reproduce (real EC2, costs money — touches shared dev)

```bash
cd apps/infra && corepack yarn install   # apps/infra is standalone; needs its own yarn.lock
export BOXLITE_ADMIN_API_KEY=<from Api ECS task def, Finding B>
export AWS_PROFILE=michaelli              # boxlite-ro for read-only discovery

# add (poll READY), then cordon immediately (a fresh SHARED runner is schedulable
# in dev — cordon before a real dev box lands on it):
./scripts/add-shared-runner-dev.sh --region-id us --name e2e-aws-throwaway-$(date +%H%M%S) \
  --instance-type c8i.large --result-file /tmp/add.json --timeout 480 --yes
curl -X PATCH -H "Authorization: Bearer $BOXLITE_ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"unschedulable":true}' https://api.dev.boxlite.ai/api/admin/runners/<id>/scheduling

# scale-down (terminates EC2 by default):
BOXLITE_API_URL=https://api.dev.boxlite.ai npx tsx scripts/scale-down-runner.ts \
  --id <id> --aws-region ap-southeast-1 --yes

# verify: GET /admin/runners/<id> → 404; describe-instances tag:RunnerId → shutting-down/terminated
```

**Cleanup discipline:** always confirm the EC2 reaches `shutting-down`/`terminated`
(`describe-instances --filters Name=tag:RunnerId,Values=<id>`). A mid-flight
failure can leave a running instance; terminate it by tag and delete the row.

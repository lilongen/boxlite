# AWS Scale-Down + Live Box Migration E2E (real EC2, dev.boxlite.ai) — 2026-05-28

Full re-run of the runner scale-up/scale-down feature on the **real dev AWS
account** (`ap-southeast-1`, `064212132677`) at integration HEAD `3f746240`,
exercising the complete design from the test plan: provision r1+r2, place boxes
on each, then scale down r1 and **migrate its live boxes to r2**. Supersedes the
empty-runner-only run in [aws-scale-down-e2e-2026-05-27.md](./aws-scale-down-e2e-2026-05-27.md).

## Test design

```
1. new r1 (ec2-1), r2 (ec2-2)        ← two FRESH SHARED runners (not `default`)
2. create boxes s11, s12 on r1
3. create boxes s21, s22 on r2
4. scale down r1  → migrate s11, s12 to r2
```

Constraints honored throughout:

- **Operate only on test-created runners.** `default` (the live dev runner) is
  never deleted/terminated — only **reversibly cordoned** during the
  placement/migration window, then restored.
- **Boxes must land on the intended runner.** No per-box `runnerId` pin exists
  (scheduler is random among ready+schedulable in-region), so placement is steered
  by cordoning every other runner (incl. `default`); a post-create assertion
  fails the run if a box lands anywhere else.
- A *complete* (with-migration) test needs a **backup-capable** runner; the
  released `v0.9.5` ships the stub, so step 0 builds one from source and
  SSM-swaps it onto r1/r2.

## Result: PASS (migration) — with one dev-API bystander-race finding

The core feature — **scale down a SHARED runner and migrate its running boxes to
a peer without losing identity** — worked end to end on real EC2:

| Step | Result |
| --- | --- |
| Build backup-capable `boxlite-runner-linux-amd64` from source (`make dev:go` + go build) | ✅ ~6.5 min on throwaway `c8i.4xlarge`, 544M, exports `boxlite_box_export` |
| Provision r1 + r2 via `add-shared-runner-dev.sh` (`c8i.large`, nested-virt) | ✅ both READY; **`BOXLITE_BACKUPS_BUCKET` auto-present in the unit** (per-env config works) |
| SSM-swap the backup binary onto r1/r2 | ✅ `active`, runner re-READY, no restart loop |
| Place s11/s12 on r1, s21/s22 on r2 (cordon-steering) | ✅ all 4 STARTED; `default` cordoned during placement, never received a test box |
| scale-down r1 → stop → **backup (Box.Export→S3)** → archive → restore on peer | ✅ all 10 stages; backup `COMPLETED` (the stage that blocked on the released runner) |
| s11/s12 migrated to r2, `started`, **`sandbox.id` preserved** | ✅ `cd23317a`,`8a4002b9` → runnerId=r2, same UUIDs |
| r1 row deleted + r1 EC2 terminated | ✅ `GET /admin/runners/r1` → 404; EC2 → terminated |
| `default` untouched | ✅ never scheduled a test box; cordon reversibly restored; 18 prod boxes intact |

IDs: r1=`26fa2725…` (EC2 `i-0a902dc049b5ca167`), r2=`14ce8738…`
(`i-09f9127a6c6f99f1c`), build EC2 `i-0fe13b5ea10b4c6a8`. snapshot=`ubuntu-dev`.

## What this proves

- The whole orchestration is correct against real infra at current HEAD:
  `AwsInfraProvider` provision/terminate, the 7-stage add and 10-stage
  scale-down, cordon-steered placement, and **in-process backup→S3→restore with
  identity preservation**.
- **The per-environment backups-bucket config refactor works**: freshly
  provisioned runners already carried `BOXLITE_BACKUPS_BUCKET=boxlite-volume-backups-dev`
  in their systemd unit (no manual SSM env needed) — only the *binary* required
  swapping, which is the known released-artifact gap below.
- The only remaining blocker for hands-off AWS migration is unchanged: the
  released `v0.9.5` runner ships the backup stub. See
  [runner-backup-not-in-released-runner.md](../follow-ups/runner-backup-not-in-released-runner.md).
  This run used a from-source backup-capable binary SSM-swapped onto r1/r2.

## Finding: bystander boxes on the migration-target peer can flip to `error`

The two **pre-existing** boxes on r2 (s21=`07d3436f`, s22=`5113a169`) — *not*
part of the migration — went to `error` during the migration window. Root cause
(from r2 `journalctl`, all timestamps 05:25Z):

```
05:23:42  s21/s22 CREATE_SANDBOX completed (placed by test-setup, started)
05:25:10  CREATE_BACKUP issued for s21 AND s22        ← not from scale-down
05:25:20  CREATE_SANDBOX issued AGAIN for s21/s22 → ERR "box with name '…' already exists (code=5)"
05:25:45  scale-down's restore of s11/s12 completes   (separate jobs, succeed)
```

`scale-down-runner.ts --id r1` only ever enumerates/operates on **r1's** boxes
(s11/s12) — it never touches a peer's own boxes. The redundant backup+create on
the r2 bystanders was issued by the **API's background reconciliation** (crons
are ON on dev), racing the migration. In the current tree the mechanism is
[`sandbox.manager.ts` `sync-states`](../../apps/api/src/sandbox/managers/sandbox.manager.ts#L678)
→ [`runnerAdapter.createSandbox`](../../apps/api/src/sandbox/managers/sandbox.manager.ts#L599)
on a desired/actual mismatch, plus
[`backup.manager.ts` `sync-stop-state-create-backups`](../../apps/api/src/sandbox/managers/backup.manager.ts#L325).
Hypothesis: under the concurrent backup+restore load of a co-located migration,
the runner's reported state lags, the reconciler treats a started box as needing
(re)creation, and the runner correctly rejects it with `already exists`.

- **Impact here:** none on real workload — s21/s22 were our own test boxes;
  `default`'s 18 prod boxes were never touched. Boxes were recoverable
  (`backupState=Completed`).
- **Why it matters:** the same reconciler exists in the current API, so migrating
  onto a peer that hosts live boxes could disrupt them in prod. Tracked as
  [runner-migration-bystander-recreate-race.md](../follow-ups/runner-migration-bystander-recreate-race.md).

## Test-environment discipline (rules honored)

`default` was only **cordoned** (reversible scheduling flag) for the
placement/migration window and **restored to `unschedulable=false`** afterward;
its EC2/lifecycle was never touched. All test runners/boxes/EC2 (r1, r2, the
build box) and all S3 artifacts (`e2e/*`, the four `.boxlite` archives) were
created by the test and cleaned up.

### Cleanup-ordering lesson

Teardown of r2 left an **inert `unresponsive` runner row** (EC2 terminated, but
2 sandbox rows stuck): I destroyed the test boxes and then terminated r2's EC2
*before the destroy jobs completed*, so they orphaned and `DELETE
/admin/runners/r2` returns `428 "has sandboxes associated"`. The EC2 (the only
cost) is gone; the row is harmless cruft (dev already has several such rows from
prior runs). **Correct teardown:** destroy boxes and wait for `destroyed`, *then*
terminate the host — exactly what `scale-down-runner.ts` does via its stage-8
drain wait; a manual teardown must replicate that ordering (or just run
`scale-down-runner.ts --id <r2> --no-require-peer`).

## Steps & exact commands / triggers (as executed)

Trigger legend: **[CLI]** = repo TypeScript script under `apps/infra/scripts`,
**[REST]** = admin HTTP call to `api.dev.boxlite.ai`, **[SSM]** = AWS Systems
Manager `RunCommand` onto an EC2, **[AWS]** = `aws` CLI.

### Common env

```bash
export AWS_PROFILE=michaelli              # full-access dev IAM user (064212132677)
export AWS_REGION=ap-southeast-1
export BOXLITE_API_URL=https://api.dev.boxlite.ai
# dev ADMIN bearer = the Api ECS service's ADMIN_API_KEY env (NOT Secrets Manager):
CLUSTER=$(aws ecs list-clusters --query 'clusterArns[?contains(@,`boxlite-dev`)]|[0]' --output text)
TD=$(aws ecs describe-services --cluster "$CLUSTER" --services Api --query 'services[0].taskDefinition' --output text)
export BOXLITE_ADMIN_API_KEY=$(aws ecs describe-task-definition --task-definition "$TD" \
  --query "taskDefinition.containerDefinitions[].environment[?name=='ADMIN_API_KEY'].value" --output text)   # masked
# infra values mirrored from the default runner EC2 (add-shared-runner-dev.sh auto-discovers these):
#   AMI=ami-0a44d8e122fd99f7f (Ubuntu Noble x86_64)  subnet=subnet-0fdf9e1fd142ac7cc
#   SG=sg-036765d8c5296e1f0   profile=RunnerProfile-434704b   backups bucket=boxlite-volume-backups-dev
```

### Step 0 — build a backup-capable runner from source  **[AWS]+[SSM]**

```bash
# 0a. launch a throwaway x86_64 build box (16 vCPU for a fast libkrunfw/cargo build)
aws ec2 run-instances --image-id ami-0a44d8e122fd99f7f --instance-type c8i.4xlarge \
  --subnet-id subnet-0fdf9e1fd142ac7cc --security-group-ids sg-036765d8c5296e1f0 \
  --iam-instance-profile Name=RunnerProfile-434704b \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":80,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=e2e-build-throwaway}]'
# 0b. bootstrap over SSM (Ubuntu Noble has no apt awscli → snap), run the build detached
aws ssm send-command --instance-ids <build-ec2> --document-name AWS-RunShellScript \
  --parameters 'commands=["snap install aws-cli --classic",
    "aws s3 cp s3://boxlite-volume-backups-dev/e2e/build.sh /opt/build.sh",
    "nohup bash /opt/build.sh >/var/log/e2e-build.log 2>&1 &"]'
```

`build.sh` recipe (uploaded to S3 first; the actual build, ~6.5 min):

```bash
git clone --branch integration/infra-local-and-runner-scale --recurse-submodules \
  https://github.com/lilongen/boxlite.git          # fork+submodules are PUBLIC → no auth
make setup:build                                     # rust, go, protoc, musl, kernel-build deps
apt-get install -y libx11-dev libxtst-dev libxinerama-dev   # computer-use cgo
make guest
make dev:go                                          # target/debug/libboxlite.a (+fix-go-symbols) + sdks/go
printf 'go 1.25.4\n\nuse (...\n\t../sdks/go\n)\n' > apps/go.work     # CI-parity workspace
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C apps build -o runner/pkg/daemon/static/daemon-amd64 ./daemon/cmd/daemon/
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go -C apps build -o runner/pkg/daemon/static/boxlite-computer-use ./libs/computer-use/
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go -C apps build -tags boxlite_dev -o /tmp/boxlite-runner-backup ./runner/cmd/runner/
nm /tmp/.../libboxlite.a | grep ' T boxlite_box_export'      # assert backup FFI present
aws s3 cp /tmp/boxlite-runner-backup s3://boxlite-volume-backups-dev/e2e/boxlite-runner-linux-amd64
```

> Note: the released `boxlite-c-v0.9.5-linux-x64-gnu` `libboxlite.a` does **not**
> export `boxlite_box_export` (verified `nm`), so the lean "download lib + go
> build" path is not possible — `boxlite-c` must be built from source.

### Step 1 — provision r1 + r2, cordon, swap the binary  **[CLI]+[REST]+[AWS]+[SSM]**

```bash
cd apps/infra
# 1a. provision each (polls to READY); cordon immediately so no dev box lands on it
./scripts/add-shared-runner-dev.sh --region-id us --name e2e-r1-$(date +%H%M%S) \
  --instance-type c8i.large --result-file /tmp/e2e-r1.json --timeout 480 --yes      # [CLI] → r1 id
curl -X PATCH -H "Authorization: Bearer $BOXLITE_ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"unschedulable":true}' "$BOXLITE_API_URL/api/admin/runners/<r1>/scheduling"  # [REST] cordon
# (repeat 1a for r2)
# 1b. find each runner's EC2 by tag, presign the artifact, SSM-swap the binary
aws ec2 describe-instances --filters Name=tag:RunnerId,Values=<r1> Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId'                                  # [AWS] → r1 EC2
PRESIGN=$(aws s3 presign s3://boxlite-volume-backups-dev/e2e/boxlite-runner-linux-amd64 --expires-in 3600)
aws ssm send-command --instance-ids <r1-ec2> <r2-ec2> --document-name AWS-RunShellScript \
  --parameters commands='["systemctl stop boxlite-runner",
    "curl -fsSL \"<PRESIGN>\" -o /usr/local/bin/boxlite-runner && chmod +x /usr/local/bin/boxlite-runner",
    "grep -q BOXLITE_BACKUPS_BUCKET /etc/systemd/system/boxlite-runner.service || sed -i ...",
    "systemctl daemon-reload && systemctl restart boxlite-runner"]'                  # [SSM] swap
```

> `BOXLITE_BACKUPS_BUCKET=boxlite-volume-backups-dev` was already present in the
> systemd unit (set by `add-shared-runner-dev.sh` per-env config) — only the
> binary needed swapping.

### Step 2 — place s11/s12 on r1, s21/s22 on r2  **[REST]+[CLI]**

```bash
# 2a. uncordon r1+r2 so placement can target them (the harness cordons the *peers*)
curl -X PATCH ... -d '{"unschedulable":false}' "$BOXLITE_API_URL/api/admin/runners/<r1>/scheduling"   # [REST] (and r2)
# 2b. place 2 boxes on each target (cordon-steered; asserts landing runner)
export BOXLITE_REGISTRY_URL=https://SnapshotManager-bcdekvub-678706435.ap-southeast-1.elb.amazonaws.com
npx tsx scripts/test-setup-scale-down.ts --reuse-r1 <r1> --reuse-r2 <r2> \
  --boxes-per-runner 2 --snapshot ubuntu-dev --result-file /tmp/e2e-testsetup.json --yes              # [CLI]
```

The harness internally: discovers bastion/DB/ALB, **seeds `snapshot_runner` for
r2 AND r1** (the r1 seed was added this run — a fresh r1 isn't `default`), then
for each target cordons every other ready runner (incl. `default`), `POST
/api/sandbox` ×2, asserts `runnerId==target`, and uncordons.

### Step 3 — scale down r1, migrating s11/s12 to r2  **[REST]+[CLI]**

```bash
# 3a. cordon default for the migration window (record prior unschedulable=false to restore)
curl -X PATCH ... -d '{"unschedulable":true}' "$BOXLITE_API_URL/api/admin/runners/<default>/scheduling"  # [REST]
# 3b. run the 10-stage scale-down (only r2 is a ready+schedulable peer ⇒ migration lands on r2)
npx tsx scripts/scale-down-runner.ts --id <r1> --aws-region ap-southeast-1 \
  --result-file /tmp/e2e-scaledown-result.json --yes                                # [CLI]
```

### Step 4 — verify  **[REST]+[AWS]**

```bash
curl -H "Authorization: Bearer $BOXLITE_ADMIN_API_KEY" "$BOXLITE_API_URL/api/sandbox/<s11>"   # state=started runnerId=<r2>
curl -o /dev/null -w '%{http_code}' ... "$BOXLITE_API_URL/api/admin/runners/<r1>"             # 404
aws ec2 describe-instances --filters Name=tag:RunnerId,Values=<r1> --query '...State.Name'     # terminated
```

### Step 5 — cleanup  **[REST]+[AWS]**

```bash
curl -X PATCH ... -d '{"unschedulable":false}' "$BOXLITE_API_URL/api/admin/runners/<default>/scheduling"  # [REST] restore default
for s in <s11> <s12> <s21> <s22>; do curl -X DELETE ... "$BOXLITE_API_URL/api/sandbox/$s"; done           # [REST] destroy test boxes
aws ec2 terminate-instances --instance-ids <r2-ec2> <build-ec2>                                            # [AWS]
aws s3 rm s3://boxlite-volume-backups-dev/e2e/ --recursive                                                 # [AWS]
aws s3 rm s3://boxlite-volume-backups-dev/<sid>.boxlite   # ×4                                             # [AWS]
# DELETE /admin/runners/<r2> returns 428 if boxes aren't fully destroyed yet — see cleanup-ordering lesson
```

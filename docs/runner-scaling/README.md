# Runner Scaling — 脚本与文档总览

> 本目录汇总 BoxLite Cloud MVP 中**手动 add runner / scale-down runner** 相关的全部脚本和说明。
>
> 本分支的工作范围（约束）：
> 1. **手动触发**（不做 auto-scaling 决策）
> 2. **只 scale-down**（scale-up = add runner，单独脚本）
> 3. **只支持 SHARED runner 之间的 box 迁移**（同 region 内）
> 4. **零 SQL 手术**（全程经 apps/api REST）
> 5. **不污染既有 runner**（patched binary 只装新建 test runner）

---

## 1. 快速索引

### 1.1 脚本（按操作员用例分类）

| 用例 | 脚本 | 一句话 |
|---|---|---|
| **加一台 SHARED runner** | [`apps/infra/scripts/add-shared-runner-dev.sh`](../../apps/infra/scripts/add-shared-runner-dev.sh) | 包装：发现 subnet/IAM + 调 add-shared-runner.ts |
| └ 底层 | [`apps/infra/scripts/add-shared-runner.ts`](../../apps/infra/scripts/add-shared-runner.ts) | POST /api/admin/runners + EC2 RunInstances（SHARED 区） |
| **加一台 CUSTOM runner**（给某 org 专用） | [`apps/infra/scripts/add-runner-dev.sh`](../../apps/infra/scripts/add-runner-dev.sh) | 包装：发现 + 调 add-runner.ts |
| └ 底层 | [`apps/infra/scripts/add-runner.ts`](../../apps/infra/scripts/add-runner.ts) | 创 CUSTOM region + POST /api/runners + EC2（org 范围） |
| **scale-down 一台 SHARED runner** | [`apps/infra/scripts/scale-down-runner.ts`](../../apps/infra/scripts/scale-down-runner.ts) | 10-stage 编排：cordon → stop → backup → archive → 迁到 peer → DELETE row → terminate EC2 |
| **scale-down E2E 测试集准备** | [`apps/infra/scripts/test-setup-scale-down.ts`](../../apps/infra/scripts/test-setup-scale-down.ts) | 在 r1+r2 上预置 sandbox 用于测试 |
| **部署 patched binary 到测试 runner** | [`scripts/deploy/deploy-patched-scaledown-binaries.sh`](../../scripts/deploy/deploy-patched-scaledown-binaries.sh) | S3 presigned + SSM RunShellScript（用于 dev 环境验证；生产应走 GitHub Release） |
| **升级生产 runner binary** | [`scripts/deploy/runner-update-binary.sh`](../../scripts/deploy/runner-update-binary.sh) | SSM 推 GitHub Release tarball |

### 1.2 共享模块

| 文件 | 用途 |
|---|---|
| [`apps/infra/lib/runner-user-data.ts`](../../apps/infra/lib/runner-user-data.ts) | EC2 user-data builder，被 `sst.config.ts` + add-runner + add-shared-runner 共用。**`--with-backup-sidecar` 现在只装 boxlite CLI（不开 systemd 服务）**，sidecar 路径在 Option A 后被废弃。 |

### 1.3 设计与报告文档

| 文档 | 内容 |
|---|---|
| [`scale-down-design.md`](./scale-down-design.md) | 集成设计，含 §11.5 架构 pivot（sidecar → in-process FFI）、§11.6 修复路径、§12 落地清单 |
| [`e2e-completion-summary.md`](./e2e-completion-summary.md) | scale-down 完成对照、§2 完整 10-stage 流程、§6 回归修复说明 |
| [`e2e-environment-setup.md`](./e2e-environment-setup.md) | E2E runbook：6 步准备清单（admin token / S3 / EC2 / 编译 / SSM / cordon） |
| [`e2e-multi-sandbox-report.md`](./e2e-multi-sandbox-report.md) | **v1**：单次 multi-sandbox E2E（暴露了 backup 副作用 stop 的回归 bug） |
| [`e2e-multi-sandbox-report-v2.md`](./e2e-multi-sandbox-report-v2.md) | **v2**：回归修复后的首次验证 |
| [`e2e-multi-sandbox-report-v3.md`](./e2e-multi-sandbox-report-v3.md) | **v3**：fresh r1 重测（r2 复用 v2） |
| [`e2e-multi-sandbox-report-v4.md`](./e2e-multi-sandbox-report-v4.md) | **v4**：双 NEW r1+r2 + 全清重建端到端验证 |
| [`apps/infra/scripts/README.md`](../../apps/infra/scripts/README.md) | `add-runner.ts` 自身的详细文档（CUSTOM runner 用，与本分支 SHARED 流程互补） |
| [`runner-ops-ui-runbook.md`](./runner-ops-ui-runbook.md) | Admin Runner Ops UI 操作 runbook（add / scale-down via dashboard） |
| [`../superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md`](../superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md) | Admin Runner Ops UI 设计 spec |

---

## 2. 三个典型操作员工作流

### 2.1 加一台新的 SHARED runner（生产容量扩容）

```bash
cd apps/infra
export AWS_PROFILE=michaelli
export BOXLITE_ADMIN_API_KEY='<从 SST state 解出来的 AdminApiKey，见 e2e-environment-setup.md §1>'

./scripts/add-shared-runner-dev.sh \
  --name runner-shared-<random6> \
  --yes
```

参数：
- **不**带 `--with-backup-sidecar`（生产 runner 用 GitHub Release binary，binary 自带 in-process backup FFI）
- 默认 c8i.2xlarge / 100 GB 根盘 / shared/us 区
- 完成后 EC2 自动注册到 apps/api，~30s 后 state=READY

### 2.2 加一台 dev test runner（带 patched binary 验证 scale-down）

```bash
cd apps/infra
export AWS_PROFILE=michaelli BOXLITE_ADMIN_API_KEY='…'

./scripts/add-shared-runner-dev.sh \
  --name runner-r1-e2e-vN \
  --with-backup-sidecar \
  --backups-bucket boxlite-volume-backups-dev \
  --no-wait --yes
```

然后部署 patched binary（仅 dev，生产走 release）：

```bash
./scripts/deploy/deploy-patched-scaledown-binaries.sh <ec2-instance-id>
```

详见 [`e2e-environment-setup.md`](./e2e-environment-setup.md)。

### 2.3 Scale-down 一台 SHARED runner

```bash
cd apps/infra
export AWS_PROFILE=michaelli BOXLITE_ADMIN_API_KEY='…'

npx tsx scripts/scale-down-runner.ts \
  --id <runner-uuid> \
  --yes
```

会自动：
1. preflight（断言 SHARED+READY、≥1 peer）
2. cordon source runner
3. 枚举 sandbox
4. **stop → backup → archive → 在 peer 上重启**（每 sandbox 串行）
5. DELETE runner row
6. terminate EC2（除非 `--skip-ec2-terminate`）

关键 flags：
- `--restart-stopped`：连带迁移 STOPPED 状态的 sandbox（默认只迁 STARTED）
- `--skip-ec2-terminate`：保留 EC2（调试用）
- `--dry-run`：只 preflight 不动状态
- `--max-wait-{backup,stop,archive,start} <s>`：各 stage 超时

详见 [`scale-down-design.md`](./scale-down-design.md) §5。

---

## 3. 10 个 stage 全流程图

```
[1/10]  Preflight                  脚本：assert source = SHARED+READY，≥1 peer
[2/10]  Cordon source              PATCH /admin/runners/:id/scheduling {unschedulable:true}
[3/10]  Enumerate sandboxes        GET /sandbox/for-runner (用 source.apiKey)
[4/10]  Stop STARTED sandboxes     POST /sandbox/:id/stop  ← 先 stop
[5/10]  Backup all sandboxes       POST /sandbox/:id/backup → runner CreateBackup
                                     ├ Box.Export → /tmp/<id>.boxlite
                                     ├ minio.PutObject → s3://<bucket>/<id>.boxlite
                                     └ SetBackupState(COMPLETED)
[6/10]  Archive                    POST /sandbox/:id/archive → runnerId=null
[7/10]  Restart on peer            POST /sandbox/:id/start
                                   → apps/api findAvailableRunners 选 peer
                                   → target runner Client.Create
                                     ├ isBackupRef 命中 → createFromBackupArchive
                                     ├ minio.FGetObject → /tmp/<id>.boxlite
                                     ├ Runtime.ImportBox(archive, id=<id>)  ← ID 保留
                                     └ bx.Start
[8/10]  Drain wait                 poll source.currentStartedSandboxes == 0
[9/10]  DELETE runner row          DELETE /admin/runners/:id
[10/10] Terminate EC2              aws ec2 terminate-instances（除非 --skip-ec2-terminate）
```

---

## 4. 已验证状态

| 验收维度 | v1 单 box | v2 multi 修复 | v3 fresh r1 | v4 全清重建 |
|---|---|---|---|---|
| scale-down exit | 0 ✅ | 0 ✅ | 0 ✅ | 0 ✅ |
| sandbox.id 保留 | ✅ | ✅ | ✅ | ✅ |
| live sandbox 不被周期 backup stop | n/a | ✅ | ✅ | ✅ |
| migration 时延（scale-down 子流程） | n/a | 42 s | 38 s | 35 s |
| r1/r2 全部新建 | — | — | r1 NEW | **r1+r2 NEW** |

→ migration 链路在 dev 环境**稳定可重复**。详见各 v\* 报告。

---

## 5. 未完成 / 已知限制

按设计 §5.4，scale-down 在生产化前**还差以下事项**（与本次实现验收无关，仅记录）：

| # | 项 | 描述 |
|---|---|---|
| 1 | **打包发布** | patched binary 现在只通过 `deploy-patched-scaledown-binaries.sh` 走 SSM ad-hoc 部署；要进生产需打到 GitHub Release tag（如 `v0.9.6`），让 EC2 user-data 直接拉 |
| 2 | **既有 runner 升级** | 现有 prod runner（default / runner-pp-test 等）仍是 v0.9.5 旧 binary，**没有 in-process backup 能力**，目前的 scale-down 只能在 patched runner 之间用 |
| 3 | **多 peer 场景的 target 选择** | apps/api `getRandomAvailableRunner` 随机选 peer，多 peer 时落点非确定 → 影响 ops debug，建议加 `--target-runner-id` flag |
| 4 | **失败回滚** | scale-down 中途如果 peer 也挂，box 可能卡在 `archived runnerId=null`；同时 error-state sandbox 会卡住 runner DELETE（v4 测试时已遇到，apps/api 缺 force-detach 路径） |
| 5 | **SnapshotRunner propagation race** | 新加 runner 后 ~1-3 分钟内创建 sandbox 可能因 ratio cron 没跑而失败（v3/v4 均观察到）；与 scale-down 无关，但影响"加新 runner 立即可用"的体验 |

---

## 6. 提交历史（branch `feat/cloud-mvp-runner-auto-scaling`）

```
58a40623  fix(runner,scale-down): decouple Stop from CreateBackup; reorder scale-down stop→backup
39dffaa3  feat(scale-down): deploy script + integrated design doc
9528cf5e  feat(runner): in-process CreateBackup + restore via FFI + S3
8fe520b8  feat(sdks): synchronous Box.Export + Runtime.ImportBox FFI
ca3827b7  feat(import): optional id_override for box ID continuity on import
900d4521  feat(infra): scripts for runner provisioning + safe scale-down
```

---

## 7. 相关代码改动一览（生产代码层）

| 层 | 文件 | 内容 |
|---|---|---|
| Rust 核心 | [`src/boxlite/src/runtime/import.rs`](../../src/boxlite/src/runtime/import.rs) | `import_box` 加 `id: Option<String>` 参数（保 sandbox.id == box.id） |
| Rust REST | [`src/cli/src/commands/serve/handlers/advanced.rs`](../../src/cli/src/commands/serve/handlers/advanced.rs) | `/boxes/import` 支持 `?id=` query |
| C SDK FFI | [`sdks/c/src/box_handle.rs`](../../sdks/c/src/box_handle.rs) | 新增 `boxlite_box_export` 同步 FFI |
| C SDK FFI | [`sdks/c/src/runtime.rs`](../../sdks/c/src/runtime.rs) | 新增 `boxlite_runtime_import_box` 同步 FFI |
| Go SDK | [`sdks/go/box_archive.go`](../../sdks/go/box_archive.go) | `Box.Export()` + `Runtime.ImportBox()` 包装 |
| 运行时业务 | [`apps/runner/pkg/boxlite/stubs.go`](../../apps/runner/pkg/boxlite/stubs.go) | `CreateBackup` (in-process export → S3) + `createFromBackupArchive` (S3 → ImportBox) + 4 个 helper |
| 运行时业务 | [`apps/runner/pkg/boxlite/client.go`](../../apps/runner/pkg/boxlite/client.go) | `Create()` 加 `isBackupRef` 分发 |
| 运行时业务 | [`apps/runner/pkg/boxlite/registry.go`](../../apps/runner/pkg/boxlite/registry.go) | `InspectImageInRegistry` 对 backup ref 走 S3 HEAD 短路 |
| 运行时业务 | [`apps/runner/pkg/api/controllers/sandbox.go`](../../apps/runner/pkg/api/controllers/sandbox.go) | `CreateBackup` handler 成功路径 SetBackupState(COMPLETED) |
| 基础设施 | [`apps/infra/lib/runner-user-data.ts`](../../apps/infra/lib/runner-user-data.ts) | 加 `BOXLITE_BACKUPS_BUCKET` env；sidecar systemd 已剥离 |
| 操作员脚本 | [`apps/infra/scripts/scale-down-runner.ts`](../../apps/infra/scripts/scale-down-runner.ts) | 10-stage 编排器；[4]/[5] 已改成 stop → backup |
| 部署工具 | [`scripts/deploy/deploy-patched-scaledown-binaries.sh`](../../scripts/deploy/deploy-patched-scaledown-binaries.sh) | SSM 推 patched binary 到 dev test runner |

---

## 8. AWS 资源

| 资源 | 用途 |
|---|---|
| S3 bucket `boxlite-volume-backups-dev` | 存 `.boxlite` 归档；落在 IAM 通配 `boxlite-volume-*` 里，runner instance profile 自动有 RW 权限。SSE-AES256 + 7d 过期。 |
| SSM RunCommand | scale-down 调用 `terminate-instances`；deploy 脚本调用 `send-command` 推 binary |
| EC2 RunInstances | add-runner / add-shared-runner 启 runner host |

---

## 9. 学习路径建议

第一次接触本目录时，建议按这个顺序读：

1. **[scale-down-design.md](./scale-down-design.md)** — 先了解整体设计意图、约束、改动清单（半小时）
2. **[e2e-completion-summary.md](./e2e-completion-summary.md)** — 看完成对照 + 10-stage 流程图 + 回归修复（15 分钟）
3. **[e2e-environment-setup.md](./e2e-environment-setup.md)** — 操作员准备 runbook（10 分钟，建议保存做参考）
4. **[e2e-multi-sandbox-report-v4.md](./e2e-multi-sandbox-report-v4.md)** — 看最近一次最严格的验收记录（10 分钟）
5. 写代码时按需查 [scale-down-design.md](./scale-down-design.md) §11.5（架构 pivot 决策）和 §11.6（FFI 路径）

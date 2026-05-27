# Scale-Down Runner: Integrated Design

> **方案 1（修平台）+ 脚本触发 + Rust upstream patch** 的完整集成方案。
>
> 范围：**SHARED 区 runner 手动 scale-down，box 安全迁移到同 region 其它 SHARED runner**。

---

## 1. 目标 / 边界

```
在 runner decommission 时，操作员手动挑选一台 SHARED runner，
该 runner 上所有 box 安全迁移到同 region 内其它 SHARED runner，
然后回收（DB DELETE + EC2 terminate）。
```

| # | 硬约束 |
|---|---|
| 1 | **手动触发**（不做 auto-scaling 决策） |
| 2 | **只 scale-down**（不 scale-up） |
| 3 | **只支持 SHARED runner**（不动 CUSTOM/DEDICATED） |
| 4 | **box 迁移仅 SHARED → SHARED**（同 region 内）；CUSTOM 间迁移**显式排除** |
| 5 | **零 SQL 手术**（不直接改 apps/api 数据库 / runner 本地 SQLite） |
| 6 | **不污染既有 runner**（所有新组件只装在新建 test runner 上） |

---

## 2. 心智模型

```
┌─────────────────────────────────────────────────────────────────────┐
│  apps/api （NestJS 控制面，不动）                                    │
│    既有 cron + state machine 主导整个 cold-migration                 │
│    /sandbox/:id/backup → /stop → /archive → /start  自然推进         │
│    boundary 规则 (regions:[sandbox.region]) 已在 start-action 里      │
└─────────────────────────────────────────────────────────────────────┘
       ▲                                  ▲
       │ HTTP 触发                        │ HTTP runner-adapter
       │                                  ▼
┌──────┴──────────────┐         ┌────────────────────────────────────┐
│ scale-down-runner.ts │         │ apps/runner 二进制（小改）          │
│  操作员的薄壳 CLI    │         │   stubs.go CreateBackup            │
│  10 阶段调既有 API   │         │     ↓ 改成转发                     │
│  不知道迁移内部细节  │         │   POST localhost:8080/.../export   │
└──────────────────────┘         │   ↓ 拿到 .boxlite 字节流           │
                                 │   ↓ S3 PutObject (presigned)       │
                                 │   ↓ 返回 s3://... 作 backupSnapshot │
                                 │                                    │
                                 │   createSandbox(backupSnapshot=s3) │
                                 │     ↓ S3 GetObject                 │
                                 │     ↓ POST localhost:8080/.../     │
                                 │       import?id=<sandbox.id>       │
                                 └────────┬───────────────────────────┘
                                          ▼
                                 ┌────────────────────────────────────┐
                                 │ boxlite serve sidecar (Rust, 新加) │
                                 │   /v1/default/boxes/:id/export     │
                                 │   /v1/default/boxes/import         │
                                 │     ↑ 加 ?id= 参数（upstream patch）│
                                 │   /v1/default/boxes/import         │
                                 │     ↑ DefaultBodyLimit::disable()  │
                                 │       (PoC 已 patch)               │
                                 │   共享 BOXLITE_HOME_DIR             │
                                 └────────────────────────────────────┘
                                          ▲
                                          ▼
                                 ┌────────────────────────────────────┐
                                 │ S3 boxlite-backups-* 桶 (transient)│
                                 │   持久化 .boxlite archive          │
                                 └────────────────────────────────────┘
```

---

## 3. 改动清单（6 项，按层）

| # | 在哪 | 改什么 | 行数 | 状态 |
|---|---|---|---|---|
| **A** | `src/cli/src/commands/serve/mod.rs` | `DefaultBodyLimit::disable()` 套 `/import` 路由 | ~4 | ✅ PoC 已 patch |
| **B** | `src/cli/...` + `src/boxlite/src/runtime/...`（5 个文件） | `/import` 加 `?id=<...>` 参数 | ~12 | ⏳ 待做 |
| **C** | `apps/runner/pkg/boxlite/stubs.go` `CreateBackup` | 改成转发到本机 `boxlite serve` + S3 上传 | ~30 | ⏳ 待做 |
| **D** | `apps/runner/pkg/...` `createSandbox` 处理 `backupSnapshot=s3://` | 加 S3 下载 + 调 `import?id=` | ~50 | ⏳ 待做 |
| **E** | `apps/infra/...` user-data + `add-shared-runner.ts` | sidecar 部署 + 用 patched binary | 已存在 | ✅ PoC 已做 |
| **F** | `apps/infra/scripts/scale-down-runner.ts` | 几乎不动；微调超时/preflight | <10 | ⏳ 待做 |

**总计**：~110 行业务代码 + 若干配置。

---

## 4. 各改动点的「为什么」

### A. `boxlite serve /import` 移除 2 MB body 限制 (~4 行 Rust) — **PoC 已做**

| 维度 | 内容 |
|---|---|
| **不改会怎样** | axum 的 `Bytes` extractor 默认 2 MB cap。PoC 阶段已撞过：alpine box 的 archive 31 MB → import 直接 `length limit exceeded` 拒掉 |
| **改了之后** | `.layer(DefaultBodyLimit::disable())` 套在 `/import` 路由上 → 任意大小 archive 都能 import |
| **为什么不在客户端切片** | import handler 用 `body: Bytes` 一次性读完，没有 chunk 接口；切片在 Rust 侧拼回需要更深改动 |

### B. `boxlite serve /import` 增 `?id=<sandbox.id>` 参数 (~12 行 Rust) — **待做**

| 维度 | 内容 |
|---|---|
| **不改会怎样** | `import_box` 永远生成新 `BoxID`（`rt_impl.rs:1006 BoxIDMint::mint()`），与 apps/api 持有的 `sandbox.id` 不同 → apps/api 后续对该 sandbox 的所有调用（exec/stop/start/delete）打到 runner :3003 都 404 |
| **改了之后** | import handler 接收可选 `?id=` → 一路传到 `provision_box(..., id_override: Option<BoxID>)` → `let box_id = id_override.unwrap_or_else(BoxIDMint::mint)` → box.id ≡ sandbox.id |
| **为什么是 upstream 改动而不是 hack** | 替代方案是 import 后手动 RENAME box（要改 boxlite SQLite + 改 `boxes/<id>/` 目录名），就回到方案 ②「DB 手术」的味道。一次性给 Rust API 加 12 行是干净的根因修复 |
| **为什么安全** | `BoxID::parse(&str)` 已有 permissive validation（URL-safe 字符 + ≤128 chars）；不合法直接返回 InvalidInput；DB 里 box.id 是 UNIQUE，重复也会被拒 |

**具体 5 处改动**：

| # | 文件 | 行号 | 改动 |
|---|---|---|---|
| 1 | `src/cli/src/commands/serve/types.rs` | 160 | `ImportQuery` 加 `pub id: Option<String>` 字段 |
| 2 | `src/cli/src/commands/serve/handlers/advanced.rs` | 122 | `state.runtime.import_box(archive, query.name, query.id)` |
| 3 | `src/boxlite/src/runtime/backend.rs` | 50 | trait `RuntimeBackend` 的 `async fn import_box` 加 `id: Option<String>` |
| 4 | `src/boxlite/src/runtime/rt_impl.rs` | 272, 1510, 997, 1006 | pub method、trait impl、provision_box 加参数 + 条件化 mint |
| 5 | `src/boxlite/src/runtime/import.rs` | 22 | `pub(crate) async fn import_box` 加参数 + `Option<String>` 转 `Option<BoxID>` |

### C. `apps/runner stubs.go` 的 `CreateBackup` 改成转发 (~30 行 Go) — **待做**

| 维度 | 内容 |
|---|---|
| **不改会怎样** | 当前 `stubs.go:112-115` 直接 `return ErrNotImplemented`。整条 cold-migration 在 apps/api 层卡死：`backupState` 永远到不了 `COMPLETED`，`shouldMoveToNewRunner` 条件不满足，sandbox 永远迁不出去 |
| **改了之后** | `CreateBackup` 做三件事：(1) HTTP `POST localhost:8080/v1/default/boxes/<id>/export` 拿 archive 字节流；(2) `aws s3 cp` 到 `s3://boxlite-backups/<sid>.boxlite`；(3) 把 `s3://...` URI 当 backupSnapshot 返回给 apps/api |
| **为什么不再多写 Rust** | sidecar 已经在本机 listen :8080，调本机 HTTP 比 cgo 进 Rust 简单且无版本耦合；S3 上传用 Go aws-sdk-v2 标准库，30 行能搞定 |
| **为什么是替换不是新增** | apps/api 既有的所有 backup 路径（warm pool / autoArchive / scale-down / dashboard 手动 backup）都会自动受益 —— 修一个点，所有场景同时通 |

### D. `apps/runner createSandbox` 处理 `backupSnapshot=s3://...` (~50 行 Go) — **待做**

| 维度 | 内容 |
|---|---|
| **不改会怎样** | apps/api `restoreSandboxOnNewRunner` 调 `runnerAdapter.createSandbox(sandbox, backupSnapshot, ...)` 时，runner 当前只会把 `backupSnapshot` 当成 Docker registry ref → 尝试 docker pull → fail。换言之，import 路径目前完全没接通 |
| **改了之后** | runner 收到 `backupSnapshot` 时检测前缀：`s3://` 走 sidecar 新路径（download from S3 → POST `localhost:8080/import?id=<sandbox.id>` 用 B 项的新参数），其它走旧路径（兼容 Daytona 模型） |
| **为什么前缀分流而不是统一 schema** | 既有 Daytona snapshot 用 docker 引用还能跑（registry pull 已工作），不打破存量；只有我们新加的 S3-backed backup 走 sidecar |
| **为什么 sandbox.id 在这里至关重要** | 这是把 B（`?id=`）和 apps/api 的 sandbox.id 模型对齐的关键缝合点。runner 必须把 apps/api 传来的 `Id` 字段透传给 sidecar，保证 box.id == sandbox.id |

### E. sidecar 部署：`add-shared-runner.ts --with-backup-sidecar` — **PoC 已做**

| 维度 | 内容 |
|---|---|
| **不改会怎样** | runner EC2 上只跑 `boxlite-runner`（Go），没有 Rust serve；调本机 sidecar 无端可调 |
| **已做内容** | `runner-user-data.ts` 增加 `withBackupSidecar` flag，flag 开启时下载 `boxlite-cli` 二进制 + 起 systemd unit `boxlite-serve.service` |
| **为什么默认 off** | 用户明确约束："只应用在新建测试 runner"。flag 默认 false 保证存量 runner 完全不受影响 |
| **为什么共享 BOXLITE_HOME_DIR** | sidecar 和 Go runner 看到的是**同一个** box DB + disk files —— Go runner 创建的 box，sidecar 能 export；sidecar import 的 box，Go runner 能 stop/start |

### F. `scale-down-runner.ts` 微调 (<10 行 TS) — **待做**

| 维度 | 内容 |
|---|---|
| **不改会怎样** | 之前写的 10 阶段脚本依旧能跑，但 backup 完成需要的时间比当初设定的 600s 长（S3 上传可能 1-2 min for 31MB），可能 timeout |
| **改了之后** | 把 `--max-wait-backup` 默认放宽到 900s；preflight 加一条"peer pool 都装了 sidecar"检查（避免 backup 完成但 target 不会 import） |
| **为什么不动 10 阶段流程** | 接通后 cold-migration 由 apps/api 既有 state machine 推动，脚本完全不用知道 sidecar/S3 的存在 —— 这正是方案 ① 的核心价值 |

### 整体改动哲学（一句话）

```
  A:    "让 import 接受大文件"      ← 工程基础设施
+ B:    "让 import 接受指定 id"     ← 与 apps/api 模型对齐
+ C:    "让 backup 真的写出 archive" ← 修复平台 stub
+ D:    "让 restore 真的能用 archive"← 接通 backup ↔ restore
+ E:    "把 sidecar 装到对的机器"   ← 部署边界控制
+ F:    "脚本知道这些都装好了"      ← UX 兜底
═══════════════════════════════════════════════════════
= 沿着 apps/api 既有的 cold-migration 调用链
  在 Rust + Go + 部署 + 脚本四个层级，
  各只填一处缺口，让整条流水线第一次能跑到底。
```

每一处改动**都是必须的**（没有任何一个改动是冗余 / 可选）；每一处改动**也是最小的**（不引入新概念 / 不破坏既有契约 / 不需要 SQL 手术）。

---

## 5. 操作员视角（最终交付形态）

```
$ tsx scripts/scale-down-runner.ts --id <runner-id> --yes
[1/10] preflight: regionType=shared ✓ peer pool=2 ✓
[2/10] cordon ✓
[3/10] enumerate sandboxes: started=3, stopped=1
[4/10] backup all (calls apps/api)... ✓     ← S3 archives created behind scenes
[5/10] stop running... ✓
[6/10] archive (runnerId cleared)... ✓
[7/10] restart on peer (sandbox.id preserved)... ✓  ← box id 在新 runner 上等于原 sandbox.id
[8/10] drain check: 0 active sandboxes on src ✓
[9/10] DELETE runner row ✓
[10/10] terminate EC2 ✓
Done. 4 sandboxes migrated to peer runners. Source decommissioned.
```

---

## 6. 单 sandbox 迁移数据流

```
Time  Source runner                Target runner          apps/api DB
──────────────────────────────────────────────────────────────────────
t=0   box X (id=SID, on src)                              runnerId=src
                                                          backupState=None
t=1   /backup ─►stubs─►serve/export
      → /tmp/X.boxlite 30 MB
      → aws s3 cp → s3://b/SID.boxlite                    backupState=PENDING
t=5                                                       backupState=COMPLETED
                                                          backupSnapshot=s3://b/SID.boxlite
t=6   /stop ──► VM quiesce                                state=STOPPED
t=8   /archive ──► destroy local box                      state=ARCHIVED
                                                          runnerId=NULL
t=10  apps/api start-action.restoreSandboxOnNewRunner
                                                          getRandomAvailableRunner({regions:[src.region]})
                                                          → picks target (same shared region)
t=11                                createSandbox(SID, backupSnap=s3://b/SID.boxlite)
                                    ↓ aws s3 cp s3://b/SID.boxlite → local
                                    ↓ POST localhost:8080/import?id=SID
                                    ↓ provision_box(staging, name, opts, Stopped, Some(SID))
                                    ↓ ✓ box id == SID
                                    ↓ apps/api start → boot VM
                                                          state=STARTED
                                                          runnerId=target
                                                          box.id == SID  ✓✓✓
t=15  /admin/runners/:src DELETE                          src row removed
t=16  aws ec2 terminate-instances                         EC2 gone
```

---

## 7. 部署边界（"只动测试 runner"）

```
existing runners                       test runners (新建)
─────────────────                       ──────────────────────
boxlite-runner v0.9.5 (官方 release)    boxlite-runner v0.9.5-patched (含 stubs.go 改动)
   stubs.go: ErrNotImplemented          stubs.go: HTTP→sidecar→S3
   (永远不会被 scale-down 触碰)         createSandbox: 支持 backupSnapshot=s3://

   无 boxlite-serve sidecar              + boxlite-serve sidecar :8080
                                           with ?id= patch
                                           with DefaultBodyLimit::disable()

→ 部署控制：add-shared-runner.ts --with-backup-sidecar 才装 sidecar
   + 同时下载 patched boxlite-runner（新 release tag 例如 v0.9.5-poc）
→ 既有 runner 的二进制版本 stay at v0.9.5 official —— 行为 0 变化
```

---

## 8. 触发链总结

```
你（操作员）
  → 一行命令
scale-down-runner.ts（薄壳，只跑既有 HTTP API）
  → 调 apps/api
apps/api（不变，所有迁移智能在这里）
  → 调 runner :3003
apps/runner（小改 30+50 行）
  → 调本地 :8080 sidecar + S3
boxlite serve sidecar（patched，~16 行）
  → 调 boxlite Rust 核心
boxlite 核心（不变，export/import/provision_box 已完整）
```

---

## 9. 工作量估算

| 类 | 改动 | 行数 |
|---|---|---|
| Rust `src/cli` + `src/boxlite` | A + B patch（body limit + `?id=` 参数） | ~16 |
| Go `apps/runner` | stubs.go CreateBackup + createSandbox S3 路径 | ~80 |
| Infra TS | scale-down-runner.ts 微调（超时、文案）| <10 |
| 部署 | release CI 加 patched binary artifact；user-data 用新版本 tag | 配置层 |
| **合计** | **~110 行业务代码 + 配置** | |

---

## 10. 风险 / 兜底

| 风险 | 缓解 |
|---|---|
| Rust patch 还没 upstream merge → 自建 release branch | 用单独 tag（如 `v0.9.5-poc`），test runner 专用 |
| S3 上传/下载失败 | apps/api 既有 backup retry cron 自动 retry |
| sandbox.id 冲突（已有同 id box 在 target） | `BoxID::parse` 配合 DB unique 约束自然拒绝 → 重试到不同 target |
| Mass deploy 失误把改动推到既有 runner | release artifact 名字不同 + sst.config.ts 不动 → 既有 runner pulumi-tracked，下次 pulumi up 不会 ignore_changes 触发 |

---

## 11. PoC 已建立的基础

| 已验证 | 文件 / 路径 |
|---|---|
| sidecar 部署机制 | [apps/infra/lib/runner-user-data.ts](../../apps/infra/lib/runner-user-data.ts) — `withBackupSidecar` flag |
| body-limit patch | [src/cli/src/commands/serve/mod.rs](../../src/cli/src/commands/serve/mod.rs) — `.layer(DefaultBodyLimit::disable())` |
| Docker build 工具链 | `.docker-cache/cargo-{registry,git}` + `docker volume boxlite-target-amd64` |
| 部署脚本 | `/tmp/deploy-patched-boxlite.sh`（S3 transient bucket + presigned URL + SSM run-command） |
| runtimes 传输 | `/tmp/transfer-runtimes-r2-to-r1.sh`（boxlite-guest / shim / libkrunfw 同步） |
| E2E 验证 | `marker → export 31 MB → import → grep -q 精确匹配 exit_code=0` |

---

## 11.5. 🚨 实施中发现的架构性阻断 (2026-05-22)

实施完毕的 patched binaries (Rust + Go) 部署到 r1-sc-e2e / r2-sc-e2e 后，E2E 测试在 `CreateBackup → sidecar export` 这一步 **永久失败**。根因 **不是** 我们的 patch，而是 BoxLite runtime 的设计约束：

```
boxlite[3177]: Error: internal error: Failed to acquire runtime lock at /var/lib/boxlite:
internal error: Another BoxliteRuntime is already using directory: /var/lib/boxlite
Only one runtime instance can use a BOXLITE_HOME directory at a time.
```

**事实链：**

1. `apps/runner` 通过 CGO 加载 `libboxlite.a`，进程启动时持有 `BOXLITE_HOME=/var/lib/boxlite` 的独占 lock。
2. `boxlite serve` sidecar 是独立 Rust 进程，启动时也想拿同一目录的 lock —— **被拒**。
3. 如果让 sidecar 用不同 home dir（如 `/var/lib/boxlite-sidecar`），它的 runtime 看不到 runner 创建的 box（`box not found: <id>`，实测 HTTP 404）。
4. 结论：**sidecar 架构在生产无法工作**。它在原始 PoC 里"成功"，是因为 PoC 时 runner 进程被关掉了，sidecar 才拿到 lock。

**这意味着方案 1 的 PoC 是 false-positive：** 验证的是 "sidecar 自己 export → S3 → 自己 import" 同进程 round-trip；没有验证 "runner 创建 box → sidecar 看到并 export"。

---

## 11.6. 修复路径选项

| 选项 | 改动范围 | 工期 | 评估 |
|---|---|---|---|
| **A. 给 C/Go SDK 加 Export/Import 绑定** | `sdks/c/src/runtime.rs` + `sdks/c/src/box_handle.rs` + cbindgen 重新生成 + `sdks/go/` 加 Go wrapper + `apps/runner/pkg/boxlite/stubs.go` 改成调 Go API（去掉 sidecar HTTP）| ~1 天 | **推荐**。Rust 侧 `RuntimeImpl::import_box` 和 `LiteBox::export_box` 已存在（`src/boxlite/src/litebox/clone_export.rs:export_box`），只需暴露 C ABI 即可。彻底消除 sidecar 进程，不再有 lock 争用。 |
| **B. 让 runner 内嵌 REST server** | 给 `apps/runner` 加新 endpoint 转发到 libboxlite 的 export/import（同上 A，但通过 HTTP 而非直接 Go 调用）| ~1.5 天 | 比 A 慢，不解决任何额外问题。 |
| **C. 走 SQLite-shared + 协调锁** | sidecar 改成可重入；runtime lock 改为 advisory + 协调协议 | ~2-3 天 | 触及 boxlite core，影响面大，不可取。 |
| **D. 完全弃用 sidecar，CreateBackup 直接 shell-out 到 `boxlite-cli` 子进程** | 需要 runner 先释放 lock（停自己的 runtime），让 cli 子进程拿 lock，结束后 runner 重新拿 lock | 取决于 runtime 能否优雅 hand-off | 不可取：backup 期间 runner 全功能停机。 |

**强烈推荐 A**。Rust 函数已经写好，只缺 FFI 桥接 + Go wrapper。

---

## 12. 下一步落地清单

按依赖顺序：

1. **B (Rust)**：5 处文件改 ~12 行；本地 Docker build；产出 patched `boxlite-cli` binary
2. **A + B 合并**：发布 `v0.9.5-poc` GitHub Release（或私有 artifact），test runner 用这个 tag
3. **C + D (Go)**：apps/runner 加 sidecar 转发 + S3 上传/下载 + import?id 调用；产出 patched `boxlite-runner` binary
4. **E（已做）+ 部署链路**：user-data 用新 release tag，flag `--with-backup-sidecar` 开启
5. **F (TS)**：`scale-down-runner.ts` 微调 timeout + preflight
6. **E2E 验证**：provision 2 台 test runner → 在 r2 上建 box → 跑 `scale-down-runner.ts --id <r2>` → box 出现在 r1 + sandbox.id 保留 + 既有 apps/api 客户端无感知

---

## 附：与方案 ② 对比

| 维度 | ①+脚本（本方案） | ② 纯脚本绕过 |
|---|---|---|
| 谁触发 | 脚本 | 脚本 |
| 谁编排 | **apps/api** cron state machine | **脚本** 自己 |
| 谁知道 boundary 规则 | apps/api 既有 `regions:[sandbox.region]` 过滤 | 脚本（重复实现）|
| 谁选 target runner | apps/api `getRandomAvailableRunner` | 脚本（cordon-others 等 hack） |
| 谁存 backupSnapshot 引用 | apps/api DB（自然字段） | 脚本（无字段 → 散在变量里） |
| 谁处理迁移失败重试 | apps/api 既有 retry cron | 脚本要自己写 |
| DB 改不改 | ❌ 0 行 SQL | ✅ 必改 2 处（runner local SQLite + apps/api Postgres） |
| 复用度 | warm pool / auto-scaling / dashboard 手动 backup 全受益 | 仅 scale-down |
| 改动量 | stubs.go ~30 行 + createSandbox 重定向 ~50 行 + 脚本几乎不动 | 脚本 +150 行 + 两层 DB 手术 |
| 架构性质 | "**修平台**" | "**绕开平台**" |

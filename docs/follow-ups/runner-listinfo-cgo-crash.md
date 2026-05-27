# Follow-up: Intermittent runner crash in Go SDK `ListInfo` (CGO)

**Filed:** 2026-05-27
**Surfaced by:** Local scale-down E2E (provider=local) — see `docs/runner-scaling/local-scale-down-e2e-2026-05-27.md`
**Owner:** TBD
**Priority:** Medium — does not block the scale-down feature (the E2E passed), but
flakes the local runner: a crash mid snapshot-pull or mid-restore aborts the
operation and forces an E2E retry.

## Symptom

The native `boxlite-runner` occasionally dies with a Go runtime fatal error
during its periodic sandbox-sync (hardcoded 10s, `apps/runner/cmd/runner/main.go:136`):

```
fatal error: invalid pointer found on stack

runtime.throw(...)
runtime.adjustpointers(...)            stack.go:681
runtime.adjustframe(...)               stack.go:738
runtime.copystack(...)                 stack.go:976
runtime.shrinkstack(...)               stack.go:1289
runtime.newstack()                     stack.go:1115
runtime.morestack()                    asm_arm64.s:392

goroutine ... [running]:
runtime.cgoCheckPointer(...)           cgocall.go:537
github.com/boxlite-ai/boxlite/sdks/go.(*Runtime).ListInfo.func1(...)   sdks/go/info.go:65
github.com/boxlite-ai/boxlite/sdks/go.(*Runtime).ListInfo(...)         sdks/go/info.go:65
github.com/boxlite-ai/runner/pkg/boxlite.(*Client).ListInfo(...)       pkg/boxlite/client.go:441
github.com/boxlite-ai/runner/pkg/services.(*SandboxSyncService).GetLocalContainerStates(...)  sandbox_sync.go:41
github.com/boxlite-ai/runner/pkg/services.(*SandboxSyncService).PerformSync(...)              sandbox_sync.go:102
github.com/boxlite-ai/runner/pkg/services.(*SandboxSyncService).StartSyncProcess.func1()      sandbox_sync.go:154
```

It is **intermittent and memoryless per sync cycle**: some runner processes
survive several minutes (the passing E2E run did); others die inside the first
minute. Observed even with **zero local boxes** (a fresh runner crashed during a
snapshot pull, before any box existed), so it is not triggered by box-info
content.

## Investigation update (2026-05-27) — localized to the #495 post-and-drain async API

Systematic-debugging pass. **Production risk is LOW**, contrary to the initial worry:

- The crash lives in the **post-and-drain async-callback machinery** introduced by
  `d8bcaadd` "feat(c-ffi): post-and-drain async callback C API (phase 2) (#495)"
  (2026-05-09): the `drainLoop` goroutine calls `boxlite_runtime_drain`, C invokes
  the Go `//export` callbacks during that call, coordinated through
  `activeHandles` / `claimHandleForDispatch` (`sdks/go/runtime.go`, `bridge_callback.go`).
- **Regression window:** `git merge-base --is-ancestor d8bcaadd sdks/go/v0.8.x..v0.9.4` → NOT an ancestor; only **v0.9.5 contains #495**. So the **vanilla production runner (sdks/go v0.8.2) predates this machinery** and uses the old direct-callback path — it is **not affected**. Only a runner built from this tree (v0.9.5/HEAD) hits the crash. This explains why dev/prod runners are stable.
- ⇒ It is **NOT a debug-vs-release issue** — a release libboxlite would not fix it (the defect is in the v0.9.5 Go/FFI drain machinery, present in both debug and release).

**Ruled out:**
- The int-token handle machinery — `handleToPtr` (reinterprets the `cgo.Handle` bits, not `&h`), `registerHandleForDispatch` (plain `sync.Map` store, returns handle unchanged). Handle values are small ints, never in the heap arena.
- Empty-`ListInfo`-only stress: 16 goroutines × 5000 calls, `runtime.GC()` every iteration, built with `GOEXPERIMENT=cgocheck2` (full cgo pointer checks) — **clean, no crash, no cgocheck violation.** So plain concurrent empty ListInfo is not the trigger; a specific GC-vs-drain interleaving (and/or non-empty results / mixed event types) is needed.
- Go-vs-header ABI skew: Go cgo and the C side share the same `sdks/c/include/boxlite.h`.

**Not yet done (blocked on reproduction):** could not reproduce in isolation, so
the exact defective line is unconfirmed. Next data-gathering options:
(a) soak the v0.9.5 debug runner under load with `GOTRACEBACK=crash` to capture the
full multi-goroutine dump + the bad-pointer address;
(b) audit the #495 machinery end-to-end — `drainLoop` + Rust `sdks/c/src/event_queue.rs`
(how queued events carry the payload / `user_data` / callback-fn pointers across the
drain boundary, and the `OwnedFfiPtr` lifetimes);
(c) defer — prod (v0.8.2) is unaffected, so this only gates shipping v0.9.5 runners.

## Likely root cause (original notes)

`runtime.adjustpointers: invalid pointer found on stack` fires from the GC stack
scanner while the goroutine stack is being copied (`copystack`) — and
`runtime.cgoCheckPointer` is on the stack at the time, i.e. the corruption is
detected during the argument check for the CGO call
`C.boxlite_list_info(r.handle, C.cbInfoList(), handleToPtr(h), &cerr)`
([`sdks/go/info.go:65`](../../sdks/go/info.go)).

This points to **memory corruption at the SDK's CGO boundary** in
`boxlite_list_info` (or the async-callback dispatch it drives) — a Go pointer on
the stack has been clobbered by the time the syncing goroutine's stack grows.
It is an SDK-layer defect, **not** a runner-ops / scale-down provider defect.

Reproduced on the `boxlite_dev` (debug) `libboxlite.a` build
(`make dev:go` → `go build -tags boxlite_dev`). Unknown whether a release
libboxlite is stable.

## Investigation leads

1. **Release vs debug build.** Rebuild libboxlite in release
   (`make runtime:release` + `cargo build -p boxlite-c --release`, link runner
   against it) and re-run the sync loop under load. If the crash disappears, the
   debug build's layout/asserts are implicated; if it persists, it is a genuine
   SDK bug.
2. **`GODEBUG=cgocheck=2`** on the runner to get a precise "Go pointer passed to
   C" diagnostic, if applicable (note: the observed error is the stack scanner,
   not cgocheck — but `cgocheck=2` may surface a clearer earlier violation).
3. **Audit the `boxlite_list_info` async path** in the C SDK + `sdks/go/info.go`
   `cbInfoList` callback / `handleToPtr` / `registerHandleForDispatch`: confirm
   no C side retains or writes through a Go pointer, and that the
   `CBoxInfoList`/`CBoxInfo` lifetime and `unsafe.Slice` use in
   `convertBoxInfoList` are sound.
4. **Compare against `sdks/go` v0.8.2** (the vanilla runner's pinned version):
   diff `info.go` / the bridge to see whether the crash path is new at HEAD.

## Workarounds while unresolved

- Re-run the local E2E if a runner dies; the scale-down logic itself is correct.
- The sync interval is hardcoded (`main.go:136`); making it env-configurable
  (e.g. `SANDBOX_SYNC_INTERVAL`) would let local E2E widen the crash window but
  does not fix the underlying corruption.

## Impact

Local-provider E2E reliability only. Production runners (AWS provider) run the
same SDK path, so if this is a genuine SDK bug it can also crash production
runners during normal sandbox-sync — **worth confirming before it ships**.

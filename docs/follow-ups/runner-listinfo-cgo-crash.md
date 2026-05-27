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

## Likely root cause

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

# macOS M5 Lima Runner Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (autonomous inline mode per `feedback_autonomy_lima_runner_branch`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a working linux/arm64 `boxlite-runner` inside a Lima VM on the M5 host, registered against the local API, capable of creating sandbox microVMs via the production-parity `KVM → libkrun` path — without disturbing the existing M5-native (HVF) runner.

**Architecture:** Mirror the EC2 amd64 path file-for-file. Add arm64 Nx targets (daemon, computer-use, runner, deb package). Author a Lima VM template with `vmType:vz` + `nestedVirtualization:true` + vmnet shared. Provision the VM with toolchain (Go/Rust/clang), build the runner from a writable source mount, install the packaged systemd unit + EnvironmentFile (a deliberate divergence from EC2's inline-unit cloud-init). Doctor + docs close out.

**Tech Stack:** Lima 1.2.1 (`vz` driver, vmnet shared, `socket_vmnet`); Nx 17+ with `@nx-go/nx-go`; Go 1.24+; Rust stable + `cargo`; Ubuntu 24.04 arm64 cloud image; existing BoxLite Go runner (libkrun KVM backend via CGO).

**Spec:** [`../specs/2026-05-26-macos-lima-runner-support-design.md`](../specs/2026-05-26-macos-lima-runner-support-design.md)

---

## File Structure

| File | Change | Task |
|---|---|---|
| `apps/daemon/project.json` | +`build-arm64` target mirroring `build-amd64` | A1 |
| `apps/libs/computer-use/project.json` | +`build-arm64` target referencing new shell script | A2 |
| `hack/computer-use/build-computer-use-arm64.sh` | New — arm64 sibling of `build-computer-use-amd64.sh` | A2 |
| `apps/runner/project.json` | +`copy-daemon-bin-arm64`, +`copy-computeruse-plugin-arm64`, +`build-arm64`, +`package-deb-arm64`; rename existing amd64 copy targets for symmetry | A3, A4, A6 |
| `apps/runner/packaging/deb/DEBIAN/control` | `Architecture: amd64` → `Architecture: ${ARCH}` template | A5 |
| `apps/runner/pkg/daemon/util.go` | **Conditional** (only if Task A0 lands on State A2): patch to `runtime.GOARCH`-keyed lookup | A0 |
| `apps/runner/pkg/daemon/util_test.go` | **Conditional**: unit test for arch-keyed lookup | A0 |
| `apps/infra-local/lima/runner.yaml` | New — Lima VM template | B1, C3 |
| `apps/infra-local/scripts/lima-up.sh` | New — `limactl start` wrapper | B2 |
| `apps/infra-local/scripts/lima-down.sh` | New — `limactl stop && limactl delete` | B3 |
| `apps/infra-local/scripts/lima-shell.sh` | New — `limactl shell default` wrapper | B4 |
| `apps/infra-local/scripts/lima-rebuild.sh` | New — rebuild runner inside VM, restart systemd | D7 |
| `apps/infra-local/scripts/lima-runner-update.sh` | New — same as rebuild but pulls latest from main first | D7 |
| `apps/infra-local/scripts/lima-tail-logs.sh` | New — `journalctl -u boxlite-runner -f` | D8 |
| `apps/infra-local/Makefile` | +`lima-up`, `lima-down`, `lima-shell`, `lima-status`, `lima-rebuild`, `lima-tail-logs`, `lima-doctor` | B5 |
| `apps/infra-local/boxlite_local/doctor.py` | +`check_lima_*` functions gated on Lima usage | B6, E1 |
| `apps/infra-local/lima/provision/install-toolchain.sh` | New — install Go/Rust/clang/seccomp/etc. | C1 |
| `apps/infra-local/lima/provision/build-runner.sh` | New — build linux/arm64 runner from source mount | C2 |
| `apps/infra-local/lima/provision/install-runner.sh` | New — install systemd unit + EnvironmentFile, start service | D1 |
| `apps/infra-local/boxlite_local/services.py` | **Conditional** (only if Phase B verification finds 127.0.0.1-bound services): switch bindings to `0.0.0.0` | B7 |
| `apps/infra-local/lima/README.md` | New — operator doc | E2 |
| `docs/apps/infra-local-status.md` | Add Lima runner section alongside M5-native | E3 |
| `CLAUDE.md` | Extend "Lima Linux Testing" with runner-host VM | E4 |
| `memory/` | Save lessons learned (one or more files) | E5 |

---

## Phase A — Build pipeline: arm64 Nx variants exist

### Task A0: Daemon-embed liveness audit (do this FIRST)

**Purpose:** Discover whether `pkg/daemon/static/*` embed has any live consumer. Outcome determines whether A0's conditional Go change ships in this phase.

**Files:**
- Read-only audit of `apps/runner/`, `sdks/go/`, `apps/daemon/`, `src/boxlite/`
- Possibly create: `apps/runner/pkg/daemon/util_test.go`
- Possibly modify: `apps/runner/pkg/daemon/util.go`

- [ ] **Step A0.1: Grep for direct consumers**

```bash
cd /Users/lilongen/github/boxlite-macos-lima-runner-support
grep -rn "WriteStaticBinary\|static.ReadFile\|pkg/daemon/static\|daemon-amd64\|daemon-arm64" \
    apps/runner/ apps/daemon/ sdks/go/ src/boxlite/ \
    --include="*.go" --include="*.rs" 2>/dev/null | grep -v "_test.go\|project.json\|.gitignore"
```

- [ ] **Step A0.2: Classify into State A1 (dead) or A2 (live but hardcoded)**

- **State A1**: only `pkg/daemon/util.go::WriteStaticBinary` defines the lookup, no callers. → Proceed to Task A1 unconditionally; no Go change.
- **State A2**: a caller invokes `WriteStaticBinary("daemon-amd64")` or `static.ReadFile("static/daemon-amd64")` literally. → Patch needed (Steps A0.3-A0.7).

- [ ] **Step A0.3 (only if A2): Add a failing unit test**

Create `apps/runner/pkg/daemon/util_test.go`:

```go
package daemon

import (
	"runtime"
	"testing"
)

func TestStaticBinaryNameMatchesGOARCH(t *testing.T) {
	expected := "daemon-" + runtime.GOARCH
	got, err := StaticBinaryName()  // helper to be added in A0.4
	if err != nil {
		t.Fatalf("StaticBinaryName: %v", err)
	}
	if got != expected {
		t.Errorf("want %q, got %q", expected, got)
	}
}
```

- [ ] **Step A0.4 (only if A2): Add the arch-keyed helper**

In `apps/runner/pkg/daemon/util.go`, add (above the existing `WriteStaticBinary`):

```go
import "runtime"

// StaticBinaryName returns the daemon binary name for the current host arch.
func StaticBinaryName() (string, error) {
	return fmt.Sprintf("daemon-%s", runtime.GOARCH), nil
}
```

Then patch the live consumer (whichever file the audit found) to call `StaticBinaryName()` instead of the hardcoded `"daemon-amd64"`.

- [ ] **Step A0.5 (only if A2): Run unit test**

```bash
cd apps/runner && go test -tags boxlite_dev ./pkg/daemon/... -v
```
Expected: PASS.

- [ ] **Step A0.6 (only if A2): Run the wider runner test suite to confirm no regression**

```bash
cd apps/runner && go test -tags boxlite_dev ./... 2>&1 | tail -20
```
Expected: no new failures vs `main`.

- [ ] **Step A0.7: Commit (with state recorded)**

```bash
git add apps/runner/pkg/daemon/
git commit -m "feat(runner): arch-keyed daemon embed lookup (Phase A0)

Audit finding: <State A1 dead embed | State A2 live caller in <file>>.
<short rationale>.

Refs: docs/superpowers/specs/2026-05-26-macos-lima-runner-support-design.md §5 Phase A"
```

(If State A1 with no code change, skip the commit; the audit result will be recorded in the Phase A wrap-up commit message.)

---

### Task A1: `apps/daemon/project.json` — add `build-arm64`

**Files:**
- Modify: `apps/daemon/project.json`

- [ ] **Step A1.1: Read the existing `build-amd64` target**

```bash
sed -n '38,60p' apps/daemon/project.json
```

- [ ] **Step A1.2: Add a sibling `build-arm64` target**

Insert into `apps/daemon/project.json`, immediately after the `build-amd64` block:

```json
,
"build-arm64": {
  "executor": "@nx-go/nx-go:build",
  "options": {
    "main": "{projectRoot}/cmd/daemon/main.go",
    "outputPath": "dist/apps/daemon-arm64",
    "env": {
      "GOARCH": "arm64",
      "GOOS": "linux",
      "CGO_ENABLED": "0"
    },
    "flags": ["-ldflags \"-X 'github.com/boxlite-ai/daemon/internal.Version=$VERSION'\""]
  },
  "inputs": [
    "goProduction",
    "^goProduction",
    { "env": "VERSION" }
  ],
  "outputs": ["{workspaceRoot}/dist/apps/daemon-arm64"]
}
```

(Exact options keys must mirror what `build-amd64` uses; copy structure verbatim and just swap GOARCH.)

- [ ] **Step A1.3: Build it**

```bash
cd /Users/lilongen/github/boxlite-macos-lima-runner-support
VERSION=0.0.0-dev yarn nx run daemon:build-arm64
```

Expected: command exits 0; `dist/apps/daemon-arm64` exists.

- [ ] **Step A1.4: Verify the binary format**

```bash
file dist/apps/daemon-arm64
```

Expected output substring: `ELF 64-bit LSB executable, ARM aarch64, ... statically linked`.

- [ ] **Step A1.5: Verify amd64 still builds (regression guard)**

```bash
VERSION=0.0.0-dev yarn nx run daemon:build-amd64
file dist/apps/daemon-amd64
```

Expected: `ELF 64-bit LSB executable, x86-64`.

- [ ] **Step A1.6: Commit**

```bash
git add apps/daemon/project.json
git commit -m "feat(daemon): add linux/arm64 build target

Mirrors build-amd64 for the M5 Lima runner path. CGO_ENABLED=0 to
keep the guest binary statically linked (matches the existing amd64
default).

Refs: docs/superpowers/specs/2026-05-26-macos-lima-runner-support-design.md §5 Phase A"
```

---

### Task A2: `apps/libs/computer-use/project.json` + new shell script

**Files:**
- Create: `hack/computer-use/build-computer-use-arm64.sh`
- Modify: `apps/libs/computer-use/project.json`

- [ ] **Step A2.1: Read the existing amd64 script as a template**

```bash
cat hack/computer-use/build-computer-use-amd64.sh
```

- [ ] **Step A2.2: Create the arm64 sibling**

Write `hack/computer-use/build-computer-use-arm64.sh` as a near-verbatim copy of the amd64 version, swapping:
- `GOARCH=amd64` → `GOARCH=arm64`
- `dist/libs/computer-use-amd64` → `dist/libs/computer-use-arm64`
- Any cross-compile linker config matching the existing amd64 cross-link approach (likely none needed if amd64 script doesn't set `CC`).

```bash
chmod +x hack/computer-use/build-computer-use-arm64.sh
```

- [ ] **Step A2.3: Add `build-arm64` target to `apps/libs/computer-use/project.json`**

Mirror the `build-amd64` block; call `./hack/computer-use/build-computer-use-arm64.sh` instead.

- [ ] **Step A2.4: Build and verify**

```bash
VERSION=0.0.0-dev yarn nx run computer-use:build-arm64
file dist/libs/computer-use-arm64
```

Expected: `ELF 64-bit LSB executable, ARM aarch64`.

- [ ] **Step A2.5: Regression check amd64**

```bash
VERSION=0.0.0-dev yarn nx run computer-use:build-amd64
file dist/libs/computer-use-amd64
```

Expected: `ELF 64-bit LSB executable, x86-64`.

- [ ] **Step A2.6: Commit**

```bash
git add hack/computer-use/build-computer-use-arm64.sh apps/libs/computer-use/project.json
git commit -m "feat(computer-use): add linux/arm64 build target + script"
```

---

### Task A3: `apps/runner/project.json` — duplicate copy targets (Option A)

**Files:**
- Modify: `apps/runner/project.json`

- [ ] **Step A3.1: Rename existing copy targets for symmetry**

In `apps/runner/project.json`, rename:
- `copy-daemon-bin` → `copy-daemon-bin-amd64`
- `copy-computeruse-plugin` → `copy-computeruse-plugin-amd64`

Find any `dependsOn` references to the old names elsewhere in the file and update them to the new amd64-suffixed names.

- [ ] **Step A3.2: Add `copy-daemon-bin-arm64` sibling**

Insert after `copy-daemon-bin-amd64`:

```json
"copy-daemon-bin-arm64": {
  "executor": "nx:run-commands",
  "options": {
    "command": "cp dist/apps/daemon-arm64 {projectRoot}/pkg/daemon/static/daemon-arm64"
  },
  "cache": true,
  "inputs": [{ "dependentTasksOutputFiles": "**/*", "transitive": true }],
  "outputs": ["{projectRoot}/pkg/daemon/static/daemon-arm64"],
  "dependsOn": [
    {
      "target": "build-arm64",
      "projects": "daemon"
    }
  ]
}
```

- [ ] **Step A3.3: Add `copy-computeruse-plugin-arm64` sibling**

Same shape, mirroring `copy-computeruse-plugin-amd64`:

```json
"copy-computeruse-plugin-arm64": {
  "executor": "nx:run-commands",
  "options": {
    "cwd": "{workspaceRoot}",
    "command": "cp dist/libs/computer-use-arm64 {projectRoot}/pkg/daemon/static/boxlite-computer-use"
  },
  "cache": true,
  "inputs": [
    "{workspaceRoot}/dist/libs/computer-use-arm64",
    { "dependentTasksOutputFiles": "**/*", "transitive": true }
  ],
  "outputs": ["{projectRoot}/pkg/daemon/static/boxlite-computer-use"],
  "dependsOn": [
    {
      "target": "build-arm64",
      "projects": "computer-use"
    }
  ]
}
```

Note: `boxlite-computer-use` (no arch suffix) is the destination filename in `static/` for both arches, since the runner reads it without arch awareness (per the current code path).

- [ ] **Step A3.4: Run the new copy targets**

```bash
VERSION=0.0.0-dev yarn nx run runner:copy-daemon-bin-arm64
VERSION=0.0.0-dev yarn nx run runner:copy-computeruse-plugin-arm64
ls -la apps/runner/pkg/daemon/static/
```

Expected: `daemon-arm64`, `daemon-amd64`, and `boxlite-computer-use` all present (with `boxlite-computer-use` matching whichever arch was copied last).

- [ ] **Step A3.5: Commit**

```bash
git add apps/runner/project.json
git commit -m "feat(runner): add -arm64 copy targets, rename -amd64 for symmetry

Option-A duplication (per design §6) — each target has fixed I/O
paths so Nx cache hashing stays sound."
```

---

### Task A4: `apps/runner/project.json` — add `build-arm64`

**Files:**
- Modify: `apps/runner/project.json`

- [ ] **Step A4.1: Add `build-arm64` mirroring `build-amd64`**

```json
"build-arm64": {
  "executor": "@nx-go/nx-go:build",
  "options": {
    "main": "{projectRoot}/cmd/runner/main.go",
    "outputPath": "dist/apps/runner-arm64",
    "env": {
      "GOARCH": "arm64",
      "GOOS": "linux"
    },
    "flags": ["-ldflags \"-X 'github.com/boxlite-ai/runner/internal.Version=$VERSION'\""]
  },
  "dependsOn": ["copy-daemon-bin-arm64", "copy-computeruse-plugin-arm64", "check-version-env"],
  "inputs": [
    "goProduction",
    "^goProduction",
    { "env": "VERSION" },
    { "dependentTasksOutputFiles": "**/*", "transitive": true }
  ]
}
```

- [ ] **Step A4.2: Update `build-amd64`'s `dependsOn` to the renamed amd64 copy targets**

Verify `build-amd64.dependsOn` now references `copy-daemon-bin-amd64` and `copy-computeruse-plugin-amd64` (not the old un-suffixed names). Fix if Task A3.1 missed it.

- [ ] **Step A4.3: Attempt cross-build from M5 (the §2 row 7 binary criterion)**

```bash
VERSION=0.0.0-dev yarn nx run runner:build-arm64 2>&1 | tee /tmp/runner-arm64-build.log
```

Two possible outcomes:

- **(i) Success:** `dist/apps/runner-arm64` exists, `file dist/apps/runner-arm64` shows `ELF aarch64`. Cross-link works on M5. → Continue to Step A4.4.
- **(ii) Failure:** any link error involving `libboxlite.a` arch mismatch, `aarch64-linux-gnu-ld` not found, missing seccomp/ssl symbols, etc. → **Do not retry indefinitely.** Document the failure in a code comment in `apps/runner/project.json`:

```json
"build-arm64": {
  // NOTE: linux/arm64 build is in-Lima only — M5 cross-link to libboxlite.a
  // (KVM backend) was investigated and judged infeasible without a custom
  // sysroot. Phase C (build-runner.sh inside Lima) is the sole producer.
  // See docs/superpowers/specs/2026-05-26-macos-lima-runner-support-design.md §2 row 7.
  ...
}
```

Skip A4.4, jump to A4.5.

- [ ] **Step A4.4 (only if cross-build succeeded): Verify binary**

```bash
file dist/apps/runner-arm64
```
Expected: `ELF 64-bit LSB executable, ARM aarch64, ... dynamically linked`.

- [ ] **Step A4.5: Verify amd64 build regression**

```bash
VERSION=0.0.0-dev yarn nx run runner:build-amd64
file dist/apps/runner-amd64
```
Expected: `ELF 64-bit LSB executable, x86-64`.

- [ ] **Step A4.6: Commit**

```bash
git add apps/runner/project.json
git commit -m "feat(runner): add linux/arm64 build target

Cross-link from M5 to linux/arm64: <succeeded | deferred to in-Lima>.
See project.json comment for rationale."
```

---

### Task A5: Parameterize `apps/runner/packaging/deb/DEBIAN/control`

**Files:**
- Modify: `apps/runner/packaging/deb/DEBIAN/control`

- [ ] **Step A5.1: Read current control file**

Line 5 today is `Architecture: amd64`.

- [ ] **Step A5.2: Replace with template**

```
Architecture: ${ARCH}
```

(Match the existing `${VERSION}` style on line 2.)

- [ ] **Step A5.3: Commit**

```bash
git add apps/runner/packaging/deb/DEBIAN/control
git commit -m "feat(runner-deb): parameterize Architecture field"
```

---

### Task A6: `apps/runner/project.json` — add `package-deb-arm64`

**Files:**
- Modify: `apps/runner/project.json`

- [ ] **Step A6.1: Read existing `package-deb`**

It hardcodes `cp dist/apps/runner-amd64`, `dpkg-deb --build ... boxlite-runner_..._amd64.deb`, and `envsubst` for `control`.

- [ ] **Step A6.2: Rename to `package-deb-amd64`; templatize `ARCH`**

Update the renamed `package-deb-amd64`:

```json
"package-deb-amd64": {
  "executor": "nx:run-commands",
  "cache": true,
  "inputs": [
    "{projectRoot}/packaging/**/*",
    { "env": "VERSION" },
    { "dependentTasksOutputFiles": "**/*", "transitive": true }
  ],
  "outputs": ["{workspaceRoot}/dist/apps/runner-deb-amd64/**/*"],
  "options": {
    "commands": [
      "mkdir -p dist/apps/runner-deb-amd64/deb/opt/boxlite",
      "mkdir -p dist/apps/runner-deb-amd64/deb/etc/systemd/system",
      "mkdir -p dist/apps/runner-deb-amd64/deb/DEBIAN",
      "cp dist/apps/runner-amd64 dist/apps/runner-deb-amd64/deb/opt/boxlite/runner",
      "cp {projectRoot}/packaging/systemd/boxlite-runner.service dist/apps/runner-deb-amd64/deb/etc/systemd/system/",
      "cp {projectRoot}/packaging/deb/DEBIAN/postinst {projectRoot}/packaging/deb/DEBIAN/prerm {projectRoot}/packaging/deb/DEBIAN/postrm dist/apps/runner-deb-amd64/deb/DEBIAN/",
      "ARCH=amd64 VERSION=${VERSION:-0.1.0} envsubst < {projectRoot}/packaging/deb/DEBIAN/control > dist/apps/runner-deb-amd64/deb/DEBIAN/control",
      "dpkg-deb --build dist/apps/runner-deb-amd64/deb dist/apps/runner-deb-amd64/boxlite-runner_${VERSION:-0.0.0-dev}_amd64.deb"
    ],
    "parallel": false
  },
  "dependsOn": ["build-amd64", "check-version-env"]
}
```

- [ ] **Step A6.3: Add `package-deb-arm64` sibling**

```json
"package-deb-arm64": {
  "executor": "nx:run-commands",
  "cache": true,
  "inputs": [
    "{projectRoot}/packaging/**/*",
    { "env": "VERSION" },
    { "dependentTasksOutputFiles": "**/*", "transitive": true }
  ],
  "outputs": ["{workspaceRoot}/dist/apps/runner-deb-arm64/**/*"],
  "options": {
    "commands": [
      "mkdir -p dist/apps/runner-deb-arm64/deb/opt/boxlite",
      "mkdir -p dist/apps/runner-deb-arm64/deb/etc/systemd/system",
      "mkdir -p dist/apps/runner-deb-arm64/deb/DEBIAN",
      "cp dist/apps/runner-arm64 dist/apps/runner-deb-arm64/deb/opt/boxlite/runner",
      "cp {projectRoot}/packaging/systemd/boxlite-runner.service dist/apps/runner-deb-arm64/deb/etc/systemd/system/",
      "cp {projectRoot}/packaging/deb/DEBIAN/postinst {projectRoot}/packaging/deb/DEBIAN/prerm {projectRoot}/packaging/deb/DEBIAN/postrm dist/apps/runner-deb-arm64/deb/DEBIAN/",
      "ARCH=arm64 VERSION=${VERSION:-0.1.0} envsubst < {projectRoot}/packaging/deb/DEBIAN/control > dist/apps/runner-deb-arm64/deb/DEBIAN/control",
      "dpkg-deb --build dist/apps/runner-deb-arm64/deb dist/apps/runner-deb-arm64/boxlite-runner_${VERSION:-0.0.0-dev}_arm64.deb"
    ],
    "parallel": false
  },
  "dependsOn": ["build-arm64", "check-version-env"]
}
```

- [ ] **Step A6.4: Run amd64 deb build (regression guard)**

```bash
VERSION=0.0.0-dev yarn nx run runner:package-deb-amd64
dpkg-deb --info dist/apps/runner-deb-amd64/*.deb | grep Architecture
```

Expected: `Architecture: amd64`.

- [ ] **Step A6.5: Run arm64 deb build IF cross-link succeeded in A4**

If A4 landed on outcome (i):

```bash
VERSION=0.0.0-dev yarn nx run runner:package-deb-arm64
dpkg-deb --info dist/apps/runner-deb-arm64/*.deb | grep Architecture
```

Expected: `Architecture: arm64`.

If A4 landed on outcome (ii), skip — the arm64 deb will be produced inside Lima during Phase D.

- [ ] **Step A6.6: Commit**

```bash
git add apps/runner/project.json
git commit -m "feat(runner): add package-deb-arm64 target; templatize Architecture"
```

---

### Phase A wrap-up checkpoint

- [ ] **Step A-end: Phase A retrospective**

Write a one-paragraph note in the PR description (or to be reused later) summarizing:
- A0 audit result (State A1 or A2)
- A4 outcome (cross-link i / Lima-only ii)
- Any deviations from the spec discovered during Phase A

This information feeds the final commit message at the end of Phase E.

---

## Phase B — Lima VM up, KVM verified

### Task B0: Prerequisites check

**Files:** None modified. This is a runtime check, not a code change.

- [ ] **Step B0.1: Check Lima version**

```bash
limactl --version
```
Expected: `limactl version 1.2.1` (or newer).

- [ ] **Step B0.2: Check socket_vmnet**

```bash
brew list socket_vmnet 2>&1 | head -1
ls -la /opt/homebrew/opt/socket_vmnet/bin/socket_vmnet 2>/dev/null
```
Expected: package listed, binary exists.

If missing:
```bash
brew install socket_vmnet
```

- [ ] **Step B0.3: Check sudoers entry**

```bash
sudo -n -l 2>&1 | grep -i socket_vmnet | head -3
```

If empty, generate and install sudoers:

```bash
limactl sudoers > /tmp/lima.sudoers
sudo install -m 0644 /tmp/lima.sudoers /etc/sudoers.d/lima
```

- [ ] **Step B0.4: Check existing Lima state — clean before B1 if needed**

```bash
limactl list
```

If a `default` instance exists from prior unrelated work and uses different settings, decide whether to delete it (`limactl delete default`) or rename our new template (e.g., to `boxlite-runner`). For this branch we'll **rename our instance** to `boxlite-runner` to avoid clobbering existing user state.

---

### Task B1: `apps/infra-local/lima/runner.yaml` (without provision blocks yet)

**Files:**
- Create: `apps/infra-local/lima/runner.yaml`

- [ ] **Step B1.1: Create directory + initial file**

```bash
mkdir -p apps/infra-local/lima
```

Write `apps/infra-local/lima/runner.yaml`:

```yaml
# BoxLite runner host — Lima VM template.
#
# Hard requirements:
#   - vmType: vz (vmnet shared only works on vz driver)
#   - nestedVirtualization: true (without this, /dev/kvm not exposed in guest,
#     and libkrun's KVM backend cannot work — see feedback memory
#     "lima-nested-virt-required").
#
# Network: vmnet shared. The VM gets its own IP on the host's vmnet subnet
# (typically 192.168.105.0/24). Requires socket_vmnet installed via brew +
# limactl sudoers configured. See apps/infra-local/lima/README.md.

vmType: vz
arch: aarch64

images:
  - location: https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img

cpus: 4
memory: 8GiB
disk: 60GiB

nestedVirtualization: true

networks:
  - lima: shared

mounts:
  - location: "~/github/boxlite-macos-lima-runner-support"
    mountPoint: "/home/{{.User}}.linux/boxlite"
    writable: true

# Phase B1: provision blocks are intentionally omitted. Phase C wires them in
# once the corresponding scripts under provision/ exist.
provision: []

containerd:
  system: false
  user: false
```

- [ ] **Step B1.2: Validate yaml syntax**

```bash
limactl validate apps/infra-local/lima/runner.yaml
```
Expected: no errors.

- [ ] **Step B1.3: Commit**

```bash
git add apps/infra-local/lima/runner.yaml
git commit -m "feat(infra-local/lima): initial runner VM template (no provision yet)

vmType vz + nestedVirtualization required for KVM passthrough; vmnet
shared so the VM gets its own IP mirroring EC2 HOST_IP semantics."
```

---

### Task B2-B4: Lima up/down/shell scripts

**Files:**
- Create: `apps/infra-local/scripts/lima-up.sh`
- Create: `apps/infra-local/scripts/lima-down.sh`
- Create: `apps/infra-local/scripts/lima-shell.sh`

- [ ] **Step B2.1: `lima-up.sh`**

```bash
#!/usr/bin/env bash
# Bring up the BoxLite Lima runner VM.
# Idempotent: if already running, exits 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIMA_NAME="${LIMA_NAME:-boxlite-runner}"
LIMA_YAML="${REPO_ROOT}/apps/infra-local/lima/runner.yaml"

if [[ ! -f "$LIMA_YAML" ]]; then
  echo "FATAL: lima yaml not found at $LIMA_YAML" >&2
  exit 1
fi

status="$(limactl list -q --filter "name=^${LIMA_NAME}$" 2>/dev/null || true)"
if [[ -n "$status" ]]; then
  current="$(limactl list --json | jq -r --arg n "$LIMA_NAME" '.[] | select(.name==$n) | .status')"
  if [[ "$current" == "Running" ]]; then
    echo "Lima VM '${LIMA_NAME}' already running."
    exit 0
  fi
  echo "Lima VM '${LIMA_NAME}' exists, starting..."
  limactl start "$LIMA_NAME"
else
  echo "Creating Lima VM '${LIMA_NAME}' from $LIMA_YAML"
  limactl start --name="$LIMA_NAME" --tty=false "$LIMA_YAML"
fi

echo
echo "Lima VM '${LIMA_NAME}' ready:"
limactl list "$LIMA_NAME"
```

```bash
chmod +x apps/infra-local/scripts/lima-up.sh
```

- [ ] **Step B3.1: `lima-down.sh`**

```bash
#!/usr/bin/env bash
# Stop and delete the BoxLite Lima runner VM (data lost).
set -euo pipefail

LIMA_NAME="${LIMA_NAME:-boxlite-runner}"

if ! limactl list -q --filter "name=^${LIMA_NAME}$" 2>/dev/null | grep -q "$LIMA_NAME"; then
  echo "Lima VM '${LIMA_NAME}' does not exist; nothing to do."
  exit 0
fi

status="$(limactl list --json | jq -r --arg n "$LIMA_NAME" '.[] | select(.name==$n) | .status')"
if [[ "$status" == "Running" ]]; then
  echo "Stopping ${LIMA_NAME}..."
  limactl stop "$LIMA_NAME"
fi

echo "Deleting ${LIMA_NAME}..."
limactl delete "$LIMA_NAME"
```

```bash
chmod +x apps/infra-local/scripts/lima-down.sh
```

- [ ] **Step B4.1: `lima-shell.sh`**

```bash
#!/usr/bin/env bash
# Open an interactive shell in the BoxLite Lima runner VM.
set -euo pipefail
LIMA_NAME="${LIMA_NAME:-boxlite-runner}"
exec limactl shell "$LIMA_NAME" "$@"
```

```bash
chmod +x apps/infra-local/scripts/lima-shell.sh
```

- [ ] **Step B2-4.commit:**

```bash
git add apps/infra-local/scripts/lima-up.sh apps/infra-local/scripts/lima-down.sh apps/infra-local/scripts/lima-shell.sh
git commit -m "feat(infra-local/lima): up/down/shell wrapper scripts"
```

---

### Task B5: `Makefile` targets

**Files:**
- Modify: `apps/infra-local/Makefile`

- [ ] **Step B5.1: Read current Makefile to find a good insertion point**

```bash
cat apps/infra-local/Makefile
```

- [ ] **Step B5.2: Add Lima targets**

Append (or insert in a logical section):

```makefile
# ── Lima runner targets ──────────────────────────────────────────────────────

.PHONY: lima-up
lima-up:  ## Bring up the Lima runner VM
	@bash scripts/lima-up.sh

.PHONY: lima-down
lima-down:  ## Stop + delete the Lima runner VM
	@bash scripts/lima-down.sh

.PHONY: lima-shell
lima-shell:  ## Open a shell inside the Lima runner VM
	@bash scripts/lima-shell.sh

.PHONY: lima-status
lima-status:  ## Print Lima runner VM status
	@limactl list "$${LIMA_NAME:-boxlite-runner}" 2>/dev/null || echo "Lima VM not present"

.PHONY: lima-rebuild
lima-rebuild:  ## Rebuild + restart the runner inside Lima
	@bash scripts/lima-rebuild.sh

.PHONY: lima-tail-logs
lima-tail-logs:  ## Stream runner journalctl logs from Lima
	@bash scripts/lima-tail-logs.sh

.PHONY: lima-doctor
lima-doctor:  ## Run Lima preflight checks
	@$(MAKE) doctor LIMA=1
```

- [ ] **Step B5.3: Commit**

```bash
git add apps/infra-local/Makefile
git commit -m "feat(infra-local): Make targets for Lima runner workflow"
```

---

### Task B6: Bring up the VM and verify KVM + L1 reachability

This is a verification task, no code authored.

- [ ] **Step B6.1: `make lima-up`**

```bash
cd apps/infra-local
make lima-up 2>&1 | tee /tmp/lima-up.log
```

Expected: VM transitions to `Running` within ~5 minutes on first run. The Ubuntu cloud image is ~600MB and gets cached at `~/.lima/_responses/`.

- [ ] **Step B6.2: Verify `/dev/kvm` exists inside guest**

```bash
limactl shell boxlite-runner -- ls -la /dev/kvm
```

Expected: `crw-rw---- 1 root kvm ...`.

If missing: nested virt isn't active. Check `runner.yaml` has `nestedVirtualization: true` and that the host is M3+ Apple Silicon on macOS 15+.

- [ ] **Step B6.3: Discover VM's vmnet IP**

```bash
limactl shell boxlite-runner -- ip -j -4 addr show lima0 | jq -r '.[0].addr_info[0].local'
```

Expected: an IP like `192.168.105.X`. Note it down — used in Phase D for `RUNNER_DOMAIN`.

- [ ] **Step B6.4: Discover host's vmnet gateway IP**

```bash
limactl shell boxlite-runner -- ip route | grep -E 'default|192.168.105' | head -3
```

Expected: a `default via 192.168.105.1 dev lima0` line (or similar). The `via` IP is the host's vmnet IP — note it. Used for `BOXLITE_API_URL`, `INSECURE_REGISTRIES`, etc.

- [ ] **Step B6.5: From host, ping VM**

```bash
ping -c 3 <vm-ip>
```

Expected: 3 successful replies.

- [ ] **Step B6.6: L1 reachability matrix (Phase B blocker per §8.5)**

Run, inside the VM, all four checks. The host gateway IP from B6.4 is `$HOSTGW`.

```bash
HOSTGW=<from B6.4>
limactl shell boxlite-runner -- bash -c "
set -e
echo '== registry =='
curl -fsS http://${HOSTGW}:25000/v2/ || echo FAIL: registry
echo '== postgres =='
nc -zv ${HOSTGW} 25432 2>&1 | tail -1 || echo FAIL: postgres
echo '== dex =='
curl -fsS http://${HOSTGW}:25556/dex/.well-known/openid-configuration -o /dev/null && echo OK: dex || echo FAIL: dex
echo '== otel-grpc =='
nc -zv ${HOSTGW} 24317 2>&1 | tail -1 || echo FAIL: otel
"
```

- [ ] **Step B6.7: If any L1 service unreachable, fix the binding (Task B7)**

If any of the four above failed with "Connection refused", the L1 box is binding to `127.0.0.1` only. Inspect `apps/infra-local/boxlite_local/services.py`, find the affected `ServiceSpec` (likely a `ports` mapping with `'127.0.0.1'` in it), and change to `0.0.0.0`. Then:

```bash
cd apps/infra-local
make stack-restart       # or stack-rebuild-l1-box for stateful services
```

Re-run B6.6 until all four pass.

- [ ] **Step B6.8: Commit any L1 binding fixes**

```bash
git add apps/infra-local/boxlite_local/services.py
git commit -m "fix(infra-local): bind L1 services to 0.0.0.0 for Lima reachability

Discovered during Phase B6 of the Lima runner spec: services bound
to 127.0.0.1 are invisible from inside the Lima vmnet-shared guest.
Affected: <list>."
```

(If no fixes needed, skip this commit.)

---

### Task B7: `doctor.py` Lima checks

**Files:**
- Modify: `apps/infra-local/boxlite_local/doctor.py`

- [ ] **Step B7.1: Read existing doctor.py**

```bash
sed -n '1,40p' apps/infra-local/boxlite_local/doctor.py
```

- [ ] **Step B7.2: Add Lima check helpers (gated on `LIMA=1` env or flag)**

Append to `doctor.py` (signature/style must match existing helpers):

```python
def _check_limactl_installed() -> Doctor:
    """Verify limactl is on PATH."""
    if shutil.which("limactl") is None:
        return Doctor.fail("limactl not found", "Install Lima: brew install lima")
    return Doctor.ok("limactl present")


def _check_socket_vmnet() -> Doctor:
    """Verify socket_vmnet is installed (required for vmnet shared)."""
    p = Path("/opt/homebrew/opt/socket_vmnet/bin/socket_vmnet")
    if not p.exists():
        return Doctor.fail(
            "socket_vmnet missing",
            "brew install socket_vmnet"
        )
    return Doctor.ok("socket_vmnet present")


def _check_lima_sudoers() -> Doctor:
    """Verify /etc/sudoers.d/lima exists and references socket_vmnet."""
    p = Path("/etc/sudoers.d/lima")
    if not p.exists():
        return Doctor.fail(
            "lima sudoers not configured",
            "limactl sudoers | sudo tee /etc/sudoers.d/lima"
        )
    return Doctor.ok("lima sudoers configured")


def _check_lima_vm_kvm() -> Doctor:
    """Verify /dev/kvm exists inside the boxlite-runner VM."""
    import subprocess
    name = os.environ.get("LIMA_NAME", "boxlite-runner")
    r = subprocess.run(
        ["limactl", "shell", name, "--", "test", "-c", "/dev/kvm"],
        capture_output=True
    )
    if r.returncode != 0:
        return Doctor.fail(
            f"/dev/kvm missing inside {name}",
            "Verify nestedVirtualization: true in lima/runner.yaml; macOS 15+ + M3+ required"
        )
    return Doctor.ok(f"/dev/kvm exposed in {name}")
```

- [ ] **Step B7.3: Wire Lima checks into the doctor entry point**

Find the existing `run_doctor()` (or equivalent). Add a Lima section that runs only when `os.environ.get("LIMA") == "1"`:

```python
if os.environ.get("LIMA") == "1":
    results.append(_check_limactl_installed())
    results.append(_check_socket_vmnet())
    results.append(_check_lima_sudoers())
    results.append(_check_lima_vm_kvm())
```

- [ ] **Step B7.4: Smoke-test `make lima-doctor`**

```bash
cd apps/infra-local
make lima-doctor
```

Expected: all four Lima checks pass.

- [ ] **Step B7.5: Commit**

```bash
git add apps/infra-local/boxlite_local/doctor.py
git commit -m "feat(infra-local/doctor): Lima preflight checks gated on LIMA=1"
```

---

### Phase B wrap-up

- [ ] **Step B-end: Phase B retrospective + cleanup**

```bash
make lima-down   # leave the VM down between phases, restart in Phase C
```

Commit any stragglers.

---

## Phase C — Build artifacts inside Lima

### Task C1: `install-toolchain.sh`

**Files:**
- Create: `apps/infra-local/lima/provision/install-toolchain.sh`

- [ ] **Step C1.1: Create script directory**

```bash
mkdir -p apps/infra-local/lima/provision
```

- [ ] **Step C1.2: Author install-toolchain.sh**

```bash
#!/usr/bin/env bash
# Install build toolchain inside the Lima runner VM.
# Idempotent: skips packages that are already present.
set -euo pipefail

GO_VERSION="${GO_VERSION:-1.25.4}"  # match top-level rust-toolchain.toml-adjacent CI go version
RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-stable}"

echo "== apt packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    build-essential \
    pkg-config \
    libseccomp-dev \
    libssl-dev \
    curl \
    git \
    protobuf-compiler \
    clang \
    jq \
    netcat-openbsd

echo "== Go ${GO_VERSION} =="
if [[ ! -d /usr/local/go || "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')" != "go${GO_VERSION}" ]]; then
    cd /tmp
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz" -o go.tgz
    rm -rf /usr/local/go
    tar -C /usr/local -xzf go.tgz
    rm go.tgz
fi
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

echo "== Rust (rustup, ${RUST_TOOLCHAIN}) =="
if [[ ! -x "$HOME/.cargo/bin/rustc" ]]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain "${RUST_TOOLCHAIN}" --profile minimal
fi
# Ensure cargo is on PATH for non-interactive shells
if ! grep -q 'cargo/env' /etc/profile.d/cargo.sh 2>/dev/null; then
    echo 'source $HOME/.cargo/env' | sudo tee /etc/profile.d/cargo.sh > /dev/null
fi

echo "== Node + corepack + yarn =="
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    apt-get install -y -qq nodejs
fi
sudo corepack enable
sudo corepack prepare yarn@stable --activate || true

echo "== done =="
go version
rustc --version
node --version
yarn --version
```

- [ ] **Step C1.3: Make executable**

```bash
chmod +x apps/infra-local/lima/provision/install-toolchain.sh
```

- [ ] **Step C1.4: Commit**

```bash
git add apps/infra-local/lima/provision/install-toolchain.sh
git commit -m "feat(infra-local/lima): provision script — install build toolchain"
```

---

### Task C2: `build-runner.sh`

**Files:**
- Create: `apps/infra-local/lima/provision/build-runner.sh`

- [ ] **Step C2.1: Author build-runner.sh**

```bash
#!/usr/bin/env bash
# Build the BoxLite runner (linux/arm64) inside the Lima VM.
# Sources from the writable mount at /home/${USER}.linux/boxlite/.
# All intermediate build state stays inside the VM ($HOME) — never on the
# mounted host tree (per design §8.6).
set -euo pipefail

REPO="/home/${USER}.linux/boxlite"
if [[ ! -d "$REPO" ]]; then
    echo "FATAL: repo mount not found at $REPO" >&2
    echo "Check Lima yaml 'mounts:' configuration." >&2
    exit 1
fi

# Keep build state out of the host repo
export NX_CACHE_DIRECTORY="${HOME}/.cache/nx"
export GOMODCACHE="${HOME}/go/pkg/mod"
export GOCACHE="${HOME}/.cache/go-build"
export CARGO_TARGET_DIR="${HOME}/cargo-target"
export YARN_CACHE_FOLDER="${HOME}/.cache/yarn"

source "${HOME}/.cargo/env" 2>/dev/null || true
export PATH="/usr/local/go/bin:${HOME}/.cargo/bin:${PATH}"

cd "$REPO"

# 1. libboxlite.a (linux/arm64, KVM backend)
echo "== building libboxlite.a (linux/arm64, KVM backend) =="
# Build via cargo, then copy into sdks/go/ where the Go runner finds it.
# CGO_CFLAGS / LDFLAGS set by sdks/go/bridge_cgo_prebuilt.go for linux.
cargo build --release -p boxlite-c --target aarch64-unknown-linux-gnu \
    --target-dir "${CARGO_TARGET_DIR}" 2>&1 | tail -5
cp "${CARGO_TARGET_DIR}/aarch64-unknown-linux-gnu/release/libboxlite.a" "${REPO}/sdks/go/libboxlite.a"

# 2. Yarn deps (Nx needs them)
echo "== yarn install =="
cd "${REPO}/apps"
yarn install --immutable

# 3. Build daemon + computer-use + runner (arm64)
echo "== nx build daemon (arm64) =="
VERSION="${VERSION:-0.0.0-dev}" yarn nx run daemon:build-arm64
echo "== nx build computer-use (arm64) =="
VERSION="${VERSION:-0.0.0-dev}" yarn nx run computer-use:build-arm64
echo "== nx build runner (arm64) =="
VERSION="${VERSION:-0.0.0-dev}" yarn nx run runner:build-arm64

echo "== verifying outputs =="
file "${REPO}/dist/apps/daemon-arm64"
file "${REPO}/dist/libs/computer-use-arm64"
file "${REPO}/dist/apps/runner-arm64"

echo "== done =="
```

- [ ] **Step C2.2: Make executable**

```bash
chmod +x apps/infra-local/lima/provision/build-runner.sh
```

- [ ] **Step C2.3: Commit**

```bash
git add apps/infra-local/lima/provision/build-runner.sh
git commit -m "feat(infra-local/lima): provision script — build linux/arm64 runner in-VM

All build state (NX cache, Go mod cache, Cargo target, Yarn cache)
redirected to \$HOME inside the VM to avoid polluting the mounted
host repo (per design §8.6)."
```

---

### Task C3: Wire provision blocks into `runner.yaml`

**Files:**
- Modify: `apps/infra-local/lima/runner.yaml`

- [ ] **Step C3.1: Replace `provision: []` with real blocks**

```yaml
provision:
  # System-level: install toolchain (apt packages, Go, Rust, Node)
  - mode: system
    script: |
      #!/usr/bin/env bash
      set -euo pipefail
      bash /home/${LIMA_CIDATA_USER}.linux/boxlite/apps/infra-local/lima/provision/install-toolchain.sh
  # User-level: build the runner binary
  - mode: user
    script: |
      #!/usr/bin/env bash
      set -euo pipefail
      bash /home/${USER}.linux/boxlite/apps/infra-local/lima/provision/build-runner.sh
  # System-level: install the binary + systemd unit + env file (Phase D1)
  - mode: system
    script: |
      #!/usr/bin/env bash
      set -euo pipefail
      bash /home/${LIMA_CIDATA_USER}.linux/boxlite/apps/infra-local/lima/provision/install-runner.sh
```

(Note: `install-runner.sh` doesn't exist yet — that's Phase D1. For Phase C, comment out the third block.)

For Phase C only, replace the third block with a placeholder comment:

```yaml
  # NOTE: third block (install-runner.sh) wired in Phase D1.
```

- [ ] **Step C3.2: Re-validate**

```bash
limactl validate apps/infra-local/lima/runner.yaml
```

- [ ] **Step C3.3: Commit**

```bash
git add apps/infra-local/lima/runner.yaml
git commit -m "feat(infra-local/lima): wire toolchain + runner-build provision blocks"
```

---

### Task C4: Fresh up — VM builds everything

- [ ] **Step C4.1: Tear down any existing instance**

```bash
cd apps/infra-local
make lima-down
```

- [ ] **Step C4.2: `make lima-up`**

```bash
make lima-up 2>&1 | tee /tmp/lima-up-phase-c.log
```

Expected: provision runs to completion (this can take 15-30 min the first time — toolchain install + cargo build + nx build).

- [ ] **Step C4.3: Verify outputs inside VM**

```bash
make lima-shell -- ls -la /home/${USER}.linux/boxlite/dist/apps/
make lima-shell -- file /home/${USER}.linux/boxlite/dist/apps/runner-arm64
make lima-shell -- file /home/${USER}.linux/boxlite/dist/apps/daemon-arm64
```

Expected: all three ELF aarch64, files exist.

- [ ] **Step C4.4: Verify libboxlite.a was built and copied**

```bash
make lima-shell -- file /home/${USER}.linux/boxlite/sdks/go/libboxlite.a
make lima-shell -- bash -c 'nm /home/${USER}.linux/boxlite/sdks/go/libboxlite.a 2>&1 | head -5; echo "size: $(stat --printf=%s /home/${USER}.linux/boxlite/sdks/go/libboxlite.a) bytes"'
```

Expected: archive present, several MB in size, symbols visible.

- [ ] **Step C4.5: Host-repo cleanliness check (per §8.6)**

```bash
git status
git diff --stat
```

Expected: only files we intentionally added/modified. No `dist/`, `target/`, `node_modules/`, `.cache/` leakage from the VM.

If leakage found: fix `build-runner.sh` to redirect that cache dir, re-run.

- [ ] **Step C4.6: Commit (only if any provision fixes needed)**

If `build-runner.sh` or `runner.yaml` was tweaked during C4, commit:

```bash
git add -p apps/infra-local/lima/
git commit -m "fix(infra-local/lima): <specific fix> discovered during first provision"
```

---

## Phase D — Runner installed + registered + golden-path L3

### Task D1: `install-runner.sh`

**Files:**
- Create: `apps/infra-local/lima/provision/install-runner.sh`

- [ ] **Step D1.1: Author install-runner.sh**

```bash
#!/usr/bin/env bash
# Install the built BoxLite runner inside the Lima VM as a systemd service.
# Mirrors apps/infra/sst.config.ts:buildRunnerUserData semantically, but
# uses the *packaged* systemd unit + EnvironmentFile rather than an inline
# unit (a deliberate divergence from EC2; see design §3 mapping table).
set -euo pipefail

REPO="/home/${SUDO_USER:-$USER}.linux/boxlite"

if [[ ! -f "${REPO}/dist/apps/runner-arm64" ]]; then
    echo "FATAL: runner-arm64 binary not found; build-runner.sh must run first" >&2
    exit 1
fi

# Install binary
install -m 0755 "${REPO}/dist/apps/runner-arm64" /opt/boxlite/runner
mkdir -p /var/lib/boxlite/runner /var/log/boxlite /etc/boxlite

# Install systemd unit (from packaging/, not inline)
install -m 0644 "${REPO}/apps/runner/packaging/systemd/boxlite-runner.service" \
    /etc/systemd/system/boxlite-runner.service

# Discover networking
VM_IP="$(ip -j -4 addr show lima0 | jq -r '.[0].addr_info[0].local')"
HOST_GW="$(ip route | awk '/^default/{print $3; exit}')"

if [[ -z "$VM_IP" || -z "$HOST_GW" ]]; then
    echo "FATAL: failed to discover networking (VM_IP='$VM_IP', HOST_GW='$HOST_GW')" >&2
    exit 1
fi

# Render env file
cat > /etc/boxlite/runner.env <<EOF
# Rendered by lima/provision/install-runner.sh at $(date -Is)
BOXLITE_API_URL=http://${HOST_GW}:3001/api
BOXLITE_RUNNER_TOKEN=local-shared-runner-token-aaaa1111
API_VERSION=2
API_PORT=3003
RUNNER_DOMAIN=${VM_IP}
BOXLITE_HOME_DIR=/var/lib/boxlite
INSECURE_REGISTRIES=${HOST_GW}:25000
AWS_REGION=ap-southeast-1
EOF
chmod 600 /etc/boxlite/runner.env

# Enable + start
systemctl daemon-reload
systemctl enable boxlite-runner
systemctl restart boxlite-runner

# Smoke check
sleep 3
systemctl is-active boxlite-runner
```

- [ ] **Step D1.2: Make executable**

```bash
chmod +x apps/infra-local/lima/provision/install-runner.sh
```

- [ ] **Step D1.3: Re-enable the third provision block in `runner.yaml`**

Replace the Phase C placeholder comment with:

```yaml
  - mode: system
    script: |
      #!/usr/bin/env bash
      set -euo pipefail
      bash /home/${LIMA_CIDATA_USER}.linux/boxlite/apps/infra-local/lima/provision/install-runner.sh
```

- [ ] **Step D1.4: Commit**

```bash
git add apps/infra-local/lima/provision/install-runner.sh apps/infra-local/lima/runner.yaml
git commit -m "feat(infra-local/lima): provision script — install runner systemd service

Uses packaged systemd unit + EnvironmentFile (intentional divergence
from EC2 inline-unit; see design §3 mapping table row 7)."
```

---

### Task D2-D6: Verify runner registers and runs sandbox e2e

- [ ] **Step D2.1: Bring up the L1 stack on host**

```bash
cd apps/infra-local
make up-with-schema
```

Expected: all 10 L1 boxes Running.

- [ ] **Step D2.2: Bring up API + Dashboard + Proxy on host (existing L2 cheatsheet)**

Follow `docs/apps/infra-local-status.md` L2 commands for API, Proxy, Dashboard. Skip the M5-native runner block — we'll only start the Lima runner.

- [ ] **Step D2.3: Recreate Lima VM (fresh provision)**

```bash
make lima-down
make lima-up 2>&1 | tee /tmp/lima-up-phase-d.log
```

Expected: VM up; provision runs all three blocks; `boxlite-runner.service` is `active`.

- [ ] **Step D2.4: Verify runner systemd status**

```bash
make lima-shell -- systemctl status boxlite-runner --no-pager
```

Expected: `Active: active (running)`.

- [ ] **Step D2.5: Verify runner heartbeat reaches API**

Watch the API logs (host-side) for `POST /admin/runners` and recurring heartbeats. Expected: a 200 OK followed by `/admin/runners/<id>/healthcheck` every 5s.

```bash
# If API logs not visible by default, tail:
limactl shell boxlite-runner -- journalctl -u boxlite-runner -n 30 --no-pager
```

Expected (in journal): log lines about successfully posting to the API URL.

- [ ] **Step D2.6: Dashboard verification**

Open `http://localhost:3000` → log in → navigate to "Runners" page. Expected: a row showing the Lima runner with IP = the vmnet IP discovered in B6.3.

- [ ] **Step D2.7: Create sandbox via dashboard, observe microVM boot**

In the dashboard:
1. Pick an arm64 image (e.g. `ubuntu:22.04` — the runner pulls per `runtime.GOARCH` post-commit `69a82bed`).
2. Create a sandbox.
3. Wait for it to reach `Started` state.

In parallel, on host:
```bash
make lima-shell -- bash -c 'ps aux | grep boxlite-shim | grep -v grep'
```

Expected: one or more `boxlite-shim` processes running inside the Lima VM.

- [ ] **Step D2.8: Verify arm64 microVM via terminal**

Open the sandbox terminal in the dashboard. Run:

```
cat /proc/cpuinfo | head -5
uname -m
```

Expected: `aarch64` in both.

- [ ] **Step D2.9: Tear down sandbox cleanly**

Delete the sandbox via dashboard. Verify in Lima that `boxlite-shim` processes drop to zero:

```bash
make lima-shell -- bash -c 'ps aux | grep boxlite-shim | grep -v grep'
```

Expected: empty output.

- [ ] **Step D2.10: Host-repo cleanliness re-check**

```bash
git status
```

Expected: no unexpected modifications from the build cycle.

- [ ] **Step D2.11: Double-registration behavior (per §7.3)**

Start the M5-native runner alongside (in another shell, following the L2 cheatsheet):

```bash
# In another shell:
BOXLITE_API_URL=http://localhost:3001/api \
BOXLITE_RUNNER_TOKEN=local-shared-runner-token-aaaa1111 \
API_VERSION=2 API_PORT=3003 \
RUNNER_DOMAIN=127.0.0.1 \
BOXLITE_HOME_DIR=$HOME/.boxlite-runner \
INSECURE_REGISTRIES=127.0.0.1:25000 \
AWS_REGION=ap-southeast-1 \
DYLD_LIBRARY_PATH=/Users/lilongen/github/boxlite-cloud-mvp/sdks/go \
/tmp/boxlite-runner
```

Observe:
- Both runners visible in dashboard Runners page? (yes/no)
- Sandbox creation still works? (try once each)
- Any scheduler errors in API logs?

Record finding in `memory/key-lessons-detailed.md` (or new memory) for Phase E5.

Kill the M5-native runner (`Ctrl-C`) before moving on.

---

### Task D7: `lima-rebuild.sh` + `lima-runner-update.sh`

**Files:**
- Create: `apps/infra-local/scripts/lima-rebuild.sh`
- Create: `apps/infra-local/scripts/lima-runner-update.sh`

- [ ] **Step D7.1: `lima-rebuild.sh`**

```bash
#!/usr/bin/env bash
# Rebuild the runner inside Lima (from current local source mount) and
# restart the systemd service. Use this after editing runner Go code.
set -euo pipefail

LIMA_NAME="${LIMA_NAME:-boxlite-runner}"

limactl shell "$LIMA_NAME" -- bash -lc '
  set -euo pipefail
  cd /home/${USER}.linux/boxlite
  bash apps/infra-local/lima/provision/build-runner.sh
  sudo install -m 0755 dist/apps/runner-arm64 /opt/boxlite/runner
  sudo systemctl restart boxlite-runner
  sleep 2
  sudo systemctl is-active boxlite-runner
'
```

```bash
chmod +x apps/infra-local/scripts/lima-rebuild.sh
```

- [ ] **Step D7.2: `lima-runner-update.sh`**

```bash
#!/usr/bin/env bash
# Pull latest main (from host repo), then rebuild + restart in Lima.
set -euo pipefail

LIMA_NAME="${LIMA_NAME:-boxlite-runner}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "== fetching latest main on host =="
git -C "$REPO_ROOT" fetch origin main
git -C "$REPO_ROOT" pull --ff-only origin main

echo "== rebuilding inside Lima =="
bash "$SCRIPT_DIR/lima-rebuild.sh"
```

```bash
chmod +x apps/infra-local/scripts/lima-runner-update.sh
```

- [ ] **Step D7.3: Commit**

```bash
git add apps/infra-local/scripts/lima-rebuild.sh apps/infra-local/scripts/lima-runner-update.sh
git commit -m "feat(infra-local/lima): rebuild + update scripts"
```

---

### Task D8: `lima-tail-logs.sh`

**Files:**
- Create: `apps/infra-local/scripts/lima-tail-logs.sh`

- [ ] **Step D8.1: Author**

```bash
#!/usr/bin/env bash
set -euo pipefail
LIMA_NAME="${LIMA_NAME:-boxlite-runner}"
limactl shell "$LIMA_NAME" -- sudo journalctl -u boxlite-runner -f
```

```bash
chmod +x apps/infra-local/scripts/lima-tail-logs.sh
```

- [ ] **Step D8.2: Commit**

```bash
git add apps/infra-local/scripts/lima-tail-logs.sh
git commit -m "feat(infra-local/lima): tail-logs helper"
```

---

## Phase E — Doctor + docs + cleanup

### Task E1: Final pass on `doctor.py` Lima checks

- [ ] **Step E1.1: Add a runtime check for the runner being active**

In `boxlite_local/doctor.py`, extend the Lima section (added in B7) with:

```python
def _check_lima_runner_active() -> Doctor:
    """Verify boxlite-runner systemd unit is active inside the VM."""
    import subprocess
    name = os.environ.get("LIMA_NAME", "boxlite-runner")
    r = subprocess.run(
        ["limactl", "shell", name, "--", "systemctl", "is-active", "boxlite-runner"],
        capture_output=True, text=True
    )
    state = r.stdout.strip()
    if state != "active":
        return Doctor.fail(
            f"boxlite-runner not active inside {name} (state: {state})",
            "make lima-up; if VM is up, make lima-tail-logs to debug"
        )
    return Doctor.ok(f"boxlite-runner active in {name}")


def _check_lima_l1_reachability() -> Doctor:
    """Verify the four L1 services are reachable from the Lima guest."""
    import subprocess
    name = os.environ.get("LIMA_NAME", "boxlite-runner")
    checks = [
        ("registry", "curl -fsS http://__GW__:25000/v2/ -o /dev/null"),
        ("postgres", "nc -zv __GW__ 25432"),
        ("dex",      "curl -fsS http://__GW__:25556/dex/.well-known/openid-configuration -o /dev/null"),
        ("otel",     "nc -zv __GW__ 24317"),
    ]
    # Discover gateway IP first
    gw_r = subprocess.run(
        ["limactl", "shell", name, "--", "bash", "-c", "ip route | awk '/^default/{print $3; exit}'"],
        capture_output=True, text=True,
    )
    gw = gw_r.stdout.strip()
    if not gw:
        return Doctor.fail("could not discover host gateway from Lima", "fix Lima networking")
    failures = []
    for label, cmd in checks:
        cmd_resolved = cmd.replace("__GW__", gw)
        r = subprocess.run(
            ["limactl", "shell", name, "--", "bash", "-c", cmd_resolved],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            failures.append(label)
    if failures:
        return Doctor.fail(
            f"unreachable from Lima: {', '.join(failures)}",
            "check apps/infra-local/boxlite_local/services.py bindings (0.0.0.0 not 127.0.0.1)"
        )
    return Doctor.ok("all L1 services reachable from Lima")
```

Wire both into the `LIMA=1` section.

- [ ] **Step E1.2: `make lima-doctor` end-to-end**

```bash
make lima-doctor
```

Expected: all checks pass.

- [ ] **Step E1.3: Commit**

```bash
git add apps/infra-local/boxlite_local/doctor.py
git commit -m "feat(infra-local/doctor): runner-active + L1-reachability checks"
```

---

### Task E2: `apps/infra-local/lima/README.md`

**Files:**
- Create: `apps/infra-local/lima/README.md`

- [ ] **Step E2.1: Write operator doc**

Content outline (must be self-contained per design §5 Phase E DoD):
- What this is (one paragraph) — parity Lima runner, when to use vs M5-native
- Prereqs: `brew install lima socket_vmnet` + `limactl sudoers | sudo tee /etc/sudoers.d/lima`
- First-time bring-up: `make lima-up` (15-30 min on first provision)
- Daily workflow: `make lima-up`, `make lima-tail-logs`, `make lima-rebuild` after Go changes
- Tear down: `make lima-down`
- Troubleshooting:
  - `/dev/kvm` missing → nested virt
  - L1 service unreachable → `0.0.0.0` binding
  - host-repo dirtied → check `NX_CACHE_DIRECTORY` envs in `build-runner.sh`
- Pointers: spec, design rationale, M5-native comparison

(Full text omitted from plan — author following design §5 Phase E will write ~200 lines of operator doc.)

- [ ] **Step E2.2: Commit**

```bash
git add apps/infra-local/lima/README.md
git commit -m "docs(infra-local/lima): operator README"
```

---

### Task E3: Update `docs/apps/infra-local-status.md`

**Files:**
- Modify: `docs/apps/infra-local-status.md`

- [ ] **Step E3.1: Add Lima runner row**

In the "L2 — Application control plane" table, add a row above or below the M5-native Go Runner row noting that Lima runner is an alternative; include short trade-off note (+8 GiB RAM, +KVM parity).

In the cheatsheet section, add a "Lima runner" subsection mirroring the existing M5-native cheatsheet:

```bash
# L2-2-alt: Runner via Lima (parity baseline)
cd apps/infra-local && make lima-up
make lima-tail-logs    # in another shell, optional
# (no host process — runner runs as systemd unit inside Lima)
```

Add an explicit "only start one runner at a time" callout.

- [ ] **Step E3.2: Commit**

```bash
git add docs/apps/infra-local-status.md
git commit -m "docs(infra-local-status): add Lima runner alongside M5-native"
```

---

### Task E4: Extend `CLAUDE.md` Lima section

**Files:**
- Modify: `CLAUDE.md` (root)

- [ ] **Step E4.1: Find "Lima Linux Testing" block in memory**

Currently in `memory/MEMORY.md` (per the system reminder). Lives outside CLAUDE.md actually — re-check whether CLAUDE.md mentions Lima at all. If not, add a new short block.

Actual edit target: `memory/MEMORY.md`, the "Lima Linux Testing" section near line 20.

- [ ] **Step E4.2: Extend to mention runner-host VM**

Add lines noting:
- `default` instance = Rust unit-test VM
- `boxlite-runner` instance = Lima runner host (this branch)
- They are independent; using both simultaneously is fine

- [ ] **Step E4.3: Commit**

```bash
git add memory/MEMORY.md
git commit -m "docs(memory): note Lima runner-host VM separate from unit-test VM"
```

(Wait — `memory/` is outside repo. The MEMORY.md edit happens via direct file write to `~/.claude/.../memory/MEMORY.md`, not a repo commit. Adjust: for repo, the equivalent is updating `CLAUDE.md`'s Lima reference if any, or leaving it alone since memory is the right home.)

If `CLAUDE.md` doesn't reference Lima, skip the commit and only update `memory/MEMORY.md`.

---

### Task E5: Memorialize lessons learned

**Files (auto-memory, outside repo):**
- Possibly create: `memory/lima-runner-lessons.md`

- [ ] **Step E5.1: Save lessons learned**

Based on findings across phases A-D, write to `~/.claude/projects/-Users-lilongen-github-boxlite/memory/lima-runner-lessons.md`:
- A0 audit outcome (State A1 / A2)
- A4 cross-link outcome
- B6/B7 L1 binding fixes (if any)
- D2.11 double-registration finding
- Anything else surprising

Index in `MEMORY.md`.

---

### Task E6: Final verification — full `lima-doctor` from clean state

- [ ] **Step E6.1: Document "clean state" for repro**

In `apps/infra-local/lima/README.md`, document the three observable preconditions per design §5 Phase E DoD:
1. `brew list lima socket_vmnet` both present
2. `/etc/sudoers.d/lima` exists with `socket_vmnet` reference
3. `~/.lima/boxlite-runner/` absent (i.e. `make lima-down` was run)

- [ ] **Step E6.2: Run full bring-up + doctor + e2e from clean state**

```bash
make lima-down
make lima-up
make lima-doctor
# Then via dashboard: create sandbox, terminal, cat /proc/cpuinfo, delete sandbox
make lima-down
```

Expected: all green, no manual interventions.

---

### Phase E wrap-up

- [ ] **Step E-final: Final spec/plan sync + commit**

If any phase deviated meaningfully from the spec, update the spec document with a "Postscript" section recording the deviation. Don't silently let the spec drift.

```bash
# If spec edits were needed:
git add docs/superpowers/specs/2026-05-26-macos-lima-runner-support-design.md
git commit -m "docs(spec): postscript with implementation deviations"
```

Mark all branch work done. Ready for review / merge.

---

## Verification check-list (from spec §11, reconfirmed)

After Phase E completion, all of these should run green from a clean state:

```bash
# Phase A regression
VERSION=0.0.0-dev yarn nx run runner:build-amd64
VERSION=0.0.0-dev yarn nx run runner:package-deb-amd64

# Phase B
make lima-up
make lima-shell -- ls /dev/kvm
make lima-shell -- ip -j -4 addr show lima0 | jq -r '.[0].addr_info[0].local'

# Phase B L1 reachability
HOSTGW=$(make lima-shell -- bash -c 'ip route | awk "/^default/{print \$3; exit}"')
make lima-shell -- curl -fsS http://${HOSTGW}:25000/v2/
make lima-shell -- nc -zv ${HOSTGW} 25432
make lima-shell -- curl -fsS http://${HOSTGW}:25556/dex/.well-known/openid-configuration -o /dev/null
make lima-shell -- nc -zv ${HOSTGW} 24317

# Phase D
make lima-shell -- systemctl is-active boxlite-runner

# Dashboard:
#   - Runners page shows Lima runner
#   - Create sandbox via dashboard
#   - Open terminal: cat /proc/cpuinfo | grep -i aarch64
#   - Delete sandbox

# Phase D host cleanliness
git status   # no unexpected files

# Phase E
make lima-doctor
```

---

## Out of scope reminders (do not creep)

- LimaInfraProvider (Phase 4 of cloud-mvp-plan, separate branch)
- Multi-Lima support
- Taking M5-native runner offline
- Dockerfile arm64
- arm64 release tarball on GitHub Releases
- Mountpoint-S3 / sandbox-volume-from-S3 parity

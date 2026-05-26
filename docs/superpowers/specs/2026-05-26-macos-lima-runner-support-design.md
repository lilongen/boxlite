# Design — macOS M5 Lima Runner Support

> Date: 2026-05-26
> Branch: `feat/macos-lima-runner-support`
> Author: solo (michael.li@polygala.ai)
> Status: Approved (verbal), pending spec-review-loop

## 1. Goal

Make the BoxLite Go runner runnable inside a Lima Linux VM on a MacBook M5,
mirroring — file for file — what the project already does to support the
"normal amd64 Linux runner" path that ships to AWS EC2. The Lima runner is the
parity baseline for the production data plane (`Linux kernel → KVM → libkrun
KVM backend`) and is a prerequisite for the later `LimaInfraProvider` /
autoscaler work in `docs/apps/cloud-mvp-plan.md` Phase 4.

## 2. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Scope:** single Lima runner, parity baseline only | Smallest closeable unit; multi-Lima and `LimaInfraProvider` are downstream and depend on this baseline existing. |
| 2 | **Build location:** all binaries built **inside** the Lima VM (Go runner, `daemon-arm64`, `computer-use-arm64`, linux/arm64 `libboxlite.a`) | Avoids brittle cross-toolchain on macOS; the in-Lima KVM-backend `libboxlite.a` is the same build the EC2 path uses. |
| 3 | **Network:** Lima `vmnet shared` — VM gets its own IP on a vmnet subnet | Mirrors EC2's `HOST_IP` model from IMDSv2; no port-forward collisions when a second Lima is added later (and §10.1 — keeps the door open). |
| 4 | **Hard constraint:** Lima yaml MUST set `vmType: vz` + `nestedVirtualization: true` | Without it `/dev/kvm` is not exposed inside the guest and libkrun's KVM backend cannot create microVMs. M5 + current macOS supports it. See `memory/feedback_lima_nested_virt_required.md`. |
| 5 | **Nx target structure:** add `-arm64` sibling targets to `-amd64` ones ("Option A — duplicate") | Nx cache stays sound, project-graph unchanged. Parameterized variants (Option B) and separate project (Option C) and out-of-Nx side files (Option D) were considered and rejected. |
| 6 | **M5 native runner:** NOT taken offline; coexists with Lima runner | Lima parity is the *long-term* default but native is the *short-term* escape hatch. Cost: two build products of `libboxlite.a` (darwin/arm64 HVF + linux/arm64 KVM), one doc paragraph, and an operational rule "start only one at a time". Go source is unchanged. |
| 7 | **Cross-link fallback policy for linux/arm64 `libboxlite.a` on M5:** try cross first, abort to "build in Lima" if cross does not work within ~2 hours of investigation | Allows the fast-iter path if it pans out, without blocking the branch on a toolchain rabbit hole. |
| 8 | **vmnet shared prerequisites accepted:** `brew install socket_vmnet` + `limactl sudoers` step is part of first-time setup | Documented in the README; `lima-doctor` detects and instructs. |

## 3. Reference-vs-target mapping

The EC2 amd64 path is the reference. The Lima arm64 path mirrors it; only the
specific items below differ.

| EC2 amd64 reference (today) | Lima arm64 equivalent (this branch) |
|---|---|
| `apps/runner/project.json` `build-amd64` (`GOARCH=amd64, GOOS=linux`) | New `build-arm64` (`GOARCH=arm64, GOOS=linux`) target |
| `apps/daemon/project.json` `build-amd64` → `dist/apps/daemon-amd64` | New `build-arm64` → `dist/apps/daemon-arm64`; runner embeds the arch matching its host |
| `apps/libs/computer-use` `build-amd64` → `dist/libs/computer-use-amd64` (via `hack/computer-use/build-computer-use-amd64.sh`) | New `build-arm64` + new `hack/computer-use/build-computer-use-arm64.sh` |
| `apps/runner/project.json` `copy-daemon-bin` (hardcoded `-amd64`) | Add `copy-daemon-bin-arm64` sibling; same shape, `-arm64` source/output |
| `apps/runner/project.json` `copy-computeruse-plugin` (hardcoded `-amd64`) | Add `copy-computeruse-plugin-arm64` sibling |
| `apps/runner/packaging/deb/DEBIAN/control` — `Architecture: amd64` hardcoded | Template the `Architecture` field with `${ARCH}`; `package-deb-amd64` + new `package-deb-arm64` Nx targets each render their own variant |
| `apps/runner/packaging/systemd/boxlite-runner.service` — arch-neutral | Reuse as-is; Lima provision script writes `/etc/boxlite/runner.env` (the unit already loads it) |
| `apps/runner/Dockerfile` (amd64 paths only) | **Not changed** — Lima does not consume a container image; runner is a systemd binary inside the guest. (Out of scope per §10.4.) |
| `apps/infra/sst.config.ts:buildRunnerUserData` — EC2 cloud-init: download tarball, write systemd unit, set env from IMDSv2 host IP, `systemctl enable --now` | `apps/infra-local/lima/runner.yaml` `provision:` blocks → call `apps/infra-local/lima/provision/{install-toolchain,build-runner,install-runner}.sh`. Builds (not downloads) the binary; reads VM IP from `ip route` (not IMDSv2); renders `/etc/boxlite/runner.env`; `systemctl enable --now boxlite-runner`. |
| `scripts/deploy/runner-update-binary.sh` (SSM Run Command pushes new tarball + restarts service) | `apps/infra-local/scripts/lima-runner-update.sh` (`limactl shell` → in-VM `nx build` against the source mount → `sudo cp` → `sudo systemctl restart`) |
| EC2 user-data hardcodes `INSECURE_REGISTRIES=<registryHost>` from SST output | Lima provision/env injects `INSECURE_REGISTRIES=<host-vmnet-ip>:25000` discovered from the VM's `ip route` / lima's host gateway address |
| `RUNNER_DOMAIN=$HOST_IP` (from IMDSv2) | `RUNNER_DOMAIN=$(ip -4 -o addr show | awk '/192.168/{print $4}' | cut -d/ -f1)` (the VM's vmnet IP) |
| Runner self-registers via `POST /admin/runners` from `apps/runner/pkg/runner/v2/healthcheck` | Same code path. `BOXLITE_API_URL=http://<host-vmnet-ip>:3001/api` is set so the heartbeat reaches the API on the host. |

Net-new artifacts with no EC2 analogue:

- `apps/infra-local/lima/runner.yaml` — the Lima VM template
- `apps/infra-local/lima/provision/install-toolchain.sh`
- `apps/infra-local/lima/provision/build-runner.sh`
- `apps/infra-local/lima/provision/install-runner.sh`
- `apps/infra-local/scripts/lima-up.sh`, `lima-down.sh`, `lima-shell.sh`, `lima-rebuild.sh`, `lima-runner-update.sh`, `lima-tail-logs.sh`
- `apps/infra-local/Makefile` targets: `lima-up`, `lima-down`, `lima-status`, `lima-rebuild`, `lima-shell`, `lima-doctor`
- Extension to `apps/infra-local/boxlite_local/doctor.py` for Lima checks (only runs when `make lima-up` was used)
- `apps/infra-local/lima/README.md`

## 4. Lima VM template — sketch

The yaml below is the design intent, not a final file. Values may move into
env / parameters during implementation.

```yaml
# apps/infra-local/lima/runner.yaml
vmType: vz
arch: aarch64
images:
  - location: https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img

cpus: 4
memory: 8GiB
disk: 60GiB

# Hard constraint — see decisions table row 4.
nestedVirtualization: true

# vmnet shared — VM gets its own IP from the vmnet subnet (~192.168.105.0/24).
# Requires `brew install socket_vmnet` + `limactl sudoers | sudo tee
# /etc/sudoers.d/lima` on first-time setup. See lima-doctor.
networks:
  - lima: shared

# Mount the repo into the VM read-write so we can build in-place.
mounts:
  - location: "~/github/boxlite-macos-lima-runner-support"
    mountPoint: "/home/${USER}.linux/boxlite"
    writable: true

# Provisioning. Each block runs once at first `limactl start`; idempotent on
# re-run via the install scripts' own checks.
provision:
  - mode: system
    script: |
      bash /home/${USER}.linux/boxlite/apps/infra-local/lima/provision/install-toolchain.sh
  - mode: user
    script: |
      bash /home/${USER}.linux/boxlite/apps/infra-local/lima/provision/build-runner.sh
  - mode: system
    script: |
      bash /home/${USER}.linux/boxlite/apps/infra-local/lima/provision/install-runner.sh
```

## 5. Phased plan

Each phase ends with a green DoD before the next starts. Solo, no parallel
work. Total estimate: ~3 days of focused effort.

### Phase A — Build pipeline: arm64 variants exist (~0.5–1 day)

**Deliverables**

- `apps/daemon/project.json` — new `build-arm64` target mirroring `build-amd64`
- `apps/libs/computer-use/project.json` — new `build-arm64` target; new
  `hack/computer-use/build-computer-use-arm64.sh`
- `apps/runner/project.json` — new `copy-daemon-bin-arm64`,
  `copy-computeruse-plugin-arm64`, `build-arm64`; new `package-deb-arm64`
- `apps/runner/packaging/deb/DEBIAN/control` — `Architecture: ${ARCH}` template

**DoD**

- `VERSION=0.0.0-dev nx build daemon --target=build-arm64` produces
  `dist/apps/daemon-arm64`; `file` reports `ELF 64-bit LSB executable,
  ARM aarch64`.
- Same for `computer-use-arm64`.
- `nx build runner --target=build-arm64` produces `dist/apps/runner-arm64`,
  `ELF aarch64`. Cross-link fallback: if cross-link from macOS to linux/arm64
  fails within ~2 hours of investigation, drop the M5-side claim and document
  that runner builds must occur in Lima; Phase C still satisfies the goal.
- All existing `build-amd64` / `package-deb` flows still pass.

### Phase B — Lima VM brought up, KVM verified (~0.5 day)

**Deliverables**

- `apps/infra-local/lima/runner.yaml` (vz + nested virt + vmnet shared; no
  provision blocks yet)
- `apps/infra-local/scripts/lima-up.sh`, `lima-down.sh`, `lima-shell.sh`
- `apps/infra-local/Makefile` targets: `lima-up`, `lima-down`, `lima-shell`,
  `lima-status`
- Extension to `apps/infra-local/boxlite_local/doctor.py`: `limactl` present,
  `socket_vmnet` installed, `limactl sudoers` configured, VM running,
  `/dev/kvm` present inside guest, VM has a vmnet IP, host vmnet gateway IP
  reachable from VM.

**DoD**

- `make lima-up` brings the VM up in ≤ 5 min on first run (subsequent runs
  are idempotent and ≤ 30 s).
- `limactl shell default -- ls -la /dev/kvm` → device node exists.
- `limactl shell default -- ip -4 -o addr show | grep -v 127.0.0.1` shows a
  vmnet IP (e.g. `192.168.105.X`).
- From host, `ping <vm-ip>` works; from VM,
  `curl http://<host-vmnet-gw-ip>:25000/v2/` reaches the L1 registry box.
- `make lima-down` deletes the VM and removes vmnet leases cleanly.

### Phase C — Build artifacts inside Lima (~0.5–1 day)

**Deliverables**

- `apps/infra-local/lima/provision/install-toolchain.sh` — installs Go,
  Rust, clang, `libseccomp-dev`, `libssl-dev`, `protobuf-compiler`,
  `build-essential`, `pkg-config` (versions pinned to match top-level
  `Cargo.toml` rust-toolchain and CI Go version).
- `apps/infra-local/lima/provision/build-runner.sh` — runs the Nx build
  commands against the read-write source mount inside the VM
  (`nx build runner --target=build-arm64`, etc.).
- `runner.yaml` `provision:` blocks wired so a fresh `lima-up` does this
  automatically.

**DoD**

- A fresh `make lima-down && make lima-up` ends with `/opt/boxlite/runner`
  present; `file` confirms ELF arm64.
- `/opt/boxlite/runner --version` runs and prints the expected version
  string from `Cargo.toml`.
- linux/arm64 `libboxlite.a` (KVM backend) lives at a known path; `nm`/`ldd`
  show no missing symbols and KVM-related Rust symbols are present.

### Phase D — Runner installed + registered + golden-path L3 (~1 day)

**Deliverables**

- `apps/infra-local/lima/provision/install-runner.sh` — copies built binary
  to `/opt/boxlite/runner`; drops `apps/runner/packaging/systemd/boxlite-runner.service`
  unmodified; renders `/etc/boxlite/runner.env` with the seven variables
  matching the EC2 user-data set (`BOXLITE_API_URL`, `BOXLITE_RUNNER_TOKEN`,
  `API_VERSION=2`, `API_PORT=3003`, `RUNNER_DOMAIN=<vm-ip>`,
  `BOXLITE_HOME_DIR=/var/lib/boxlite`,
  `INSECURE_REGISTRIES=<host-vmnet-gw-ip>:25000`,
  `AWS_REGION=us-east-1`); `systemctl enable --now boxlite-runner`.
- `apps/infra-local/scripts/lima-runner-update.sh` — pulls latest source via
  the mount, rebuilds in VM, restarts the systemd unit.
- `apps/infra-local/scripts/lima-tail-logs.sh` — `limactl shell default --
  journalctl -u boxlite-runner -f`.

**DoD**

- `systemctl status boxlite-runner` inside Lima reports `active (running)`.
- API logs show `POST /admin/runners` arriving from `<vm-ip>` and 5-second
  heartbeats. Dashboard "Runners" page shows the Lima runner registered.
- Create a sandbox via dashboard → microVM boots inside Lima — observed by
  `limactl shell default -- ps aux | grep boxlite-shim`.
- Open the sandbox terminal in the browser; `cat /proc/cpuinfo` inside the
  microVM reports aarch64.

### Phase E — Doctor + docs + cleanup (~0.5 day)

**Deliverables**

- Final pass over `apps/infra-local/boxlite_local/doctor.py` Lima checks.
- `apps/infra-local/lima/README.md` — what this is, how to use,
  troubleshooting, vs M5-native runner choice.
- Update `docs/apps/infra-local-status.md` to add the Lima runner alongside
  the M5-native entry with the trade-off note (parity benefit vs +2-3 GB RAM).
- Update `CLAUDE.md` "Lima Linux Testing" section (currently focused on
  Rust unit tests) to also reference the runner-host VM.
- Save lessons learned to `memory/` (file paths, gotchas).

**DoD**

- `make lima-doctor` passes on a clean machine after `make lima-up`.
- A reader following `apps/infra-local/lima/README.md` from scratch can
  `make lima-up && create sandbox via dashboard && delete sandbox &&
  make lima-down` without consulting other docs.
- `docs/apps/infra-local-status.md` accurately describes "M5 native runner"
  vs "Lima runner" — which is default, how to switch.

## 6. Build-pipeline gaps — Option A specifics

Per decision row 5, `apps/runner/project.json` gets two sibling target
blocks for daemon/computer-use copy and two for build/package. The shape:

```jsonc
// New blocks (sketch — final names may shift slightly)
"copy-daemon-bin-amd64": {     // renamed from "copy-daemon-bin"
  "command": "cp dist/apps/daemon-amd64 {projectRoot}/pkg/daemon/static/daemon-amd64",
  "outputs": ["{projectRoot}/pkg/daemon/static/daemon-amd64"],
  "dependsOn": [{ "target": "build-amd64", "projects": "daemon" }]
},
"copy-daemon-bin-arm64": {     // new
  "command": "cp dist/apps/daemon-arm64 {projectRoot}/pkg/daemon/static/daemon-arm64",
  "outputs": ["{projectRoot}/pkg/daemon/static/daemon-arm64"],
  "dependsOn": [{ "target": "build-arm64", "projects": "daemon" }]
},
// same shape for copy-computeruse-plugin-{amd64,arm64}

"build-amd64": { "dependsOn": ["copy-daemon-bin-amd64", "copy-computeruse-plugin-amd64", "check-version-env"], ... },
"build-arm64": { "dependsOn": ["copy-daemon-bin-arm64", "copy-computeruse-plugin-arm64", "check-version-env"], ... }
```

The runner binary embeds the daemon matching its host arch — picked at
runtime by reading `runtime.GOARCH` inside the runner's daemon-injection
code. (Phase A confirms this code path picks `daemon-${runtime.GOARCH}`;
if today it hardcodes `daemon-amd64`, that line gets fixed as part of
Phase A.)

## 7. Out of scope (explicit)

### 7.1 `LimaInfraProvider` in NestJS API

The `IInfraProvider` abstraction and its Lima implementation are Phase 4 of
`docs/apps/cloud-mvp-plan.md`. Without the parity baseline this branch
delivers, the provider has nothing meaningful to validate. Deferred to the
next branch.

### 7.2 Multi-Lima support

24 GB M5 can host 2–3 Lima VMs but multi-VM coordination depends on the
provider in 7.1. The vmnet-shared network choice keeps this door open
(each VM gets a unique IP automatically), but no scripts in this branch
attempt to bring up more than one.

### 7.3 Do not take the M5-native runner offline

Lima runner coexists with the M5-native (`/tmp/boxlite-runner` + HVF) path.
Go source is unchanged; the cost of coexistence is:

- Two `libboxlite.a` builds (darwin/arm64 HVF + linux/arm64 KVM).
- One paragraph in `docs/apps/infra-local-status.md` explaining which is in
  use and how to switch.
- Operational rule: start only one runner at a time to avoid double
  registration / scheduler confusion. (Whether double-registration is
  actually harmful is itself a check item in Phase E.)

### 7.4 Dockerfile arm64

`apps/runner/Dockerfile` stays amd64-only. Lima installs the runner as a
systemd unit; production ECS stays amd64. Multi-arch container images are
a separate decision.

### 7.5 arm64 release tarball on GitHub Releases

Lima builds from source via the mount; there is no need for
`boxlite-runner-v${VERSION}-linux-arm64.tar.gz` on GitHub Releases. Once
Phase A targets exist, CI can add a `matrix: [amd64, arm64]` if a consumer
appears; that's an independent half-day of work, deferred.

## 8. Risks

### 8.1 M5 cross-link of linux/arm64 `libboxlite.a` may not be straightforward

`scripts/build/build-guest.sh` already has musl-cross logic, but it is
tuned for the *guest binary* (statically linked init, no KVM calls), not
the runner *library* which has KVM, libseccomp, protobuf, and other deps.
Potential pitfalls: triple choice (`aarch64-unknown-linux-gnu` for Lima
Ubuntu vs `aarch64-unknown-linux-musl` for prod alpine — not
interchangeable); cross linker availability (`aarch64-linux-gnu-ld` not
shipped by Brew's `musl-cross`); sys-lib cross-build for
libseccomp/libssl/protobuf.

**Mitigation:** Phase A's DoD permits a fallback — if 2 hours of
investigation does not yield a working cross-link, drop the M5-side build
claim and let Phase C own all builds. The branch goal (Lima runner
running) is unaffected.

### 8.2 vmnet shared requires `socket_vmnet` + `sudoers`

First-time setup is not one-shot:

```bash
brew install socket_vmnet
limactl sudoers | sudo tee /etc/sudoers.d/lima
make lima-up
```

Risks: a `sudo` prompt breaks "one-shot" UX; macOS upgrades can break
vmnet entitlements; `192.168.105.0/24` subnet may collide with UTM /
Parallels / Docker Desktop's own vmnet.

**Mitigation:** `lima-doctor` detects each prerequisite and prints the
exact command to fix; `apps/infra-local/lima/README.md` documents the
three steps prominently.

### 8.3 Nx `copy-daemon-bin` arch-awareness

Current `apps/runner/project.json` hardcodes `daemon-amd64` filename in
the `command`, `outputs`, and `dependsOn`. Naïve dynamic substitution
breaks Nx cache hashing. Decision row 5 picks Option A (duplicate target
block) precisely to avoid this — Nx sees fixed I/O paths per target.

### 8.4 The M5-native runner today also lacks `daemon-arm64`

The runner's embedded daemon-arm64 may already be missing on the
M5-native path (only `daemon-amd64` is copied by the existing Nx target).
Whether today's M5-native sandboxes actually run an arm64 daemon
(observable via `cat /proc/cpuinfo` inside the microVM) is an open data
point. Phase A's daemon-arm64 build target will be picked up by the
runner's arch-selecting injection code, which may either fix or surface a
hidden defect on the M5-native path. Phase D and Phase E will explicitly
verify behavior on both paths.

## 9. Layout — where new files live

```
apps/infra-local/
├── Makefile                            # +lima-up / lima-down / ...
├── boxlite_local/
│   └── doctor.py                       # +lima checks (gated)
├── lima/
│   ├── README.md                       # operator doc (Phase E)
│   ├── runner.yaml                     # Lima VM template (Phase B-C)
│   └── provision/
│       ├── install-toolchain.sh        # Phase C
│       ├── build-runner.sh             # Phase C
│       └── install-runner.sh           # Phase D
└── scripts/
    ├── lima-up.sh                      # Phase B
    ├── lima-down.sh                    # Phase B
    ├── lima-shell.sh                   # Phase B
    ├── lima-rebuild.sh                 # Phase D
    ├── lima-runner-update.sh           # Phase D
    └── lima-tail-logs.sh               # Phase D

apps/daemon/project.json                # +build-arm64                       (Phase A)
apps/libs/computer-use/project.json     # +build-arm64                       (Phase A)
hack/computer-use/build-computer-use-arm64.sh   # new                        (Phase A)
apps/runner/project.json                # +copy-{daemon-bin,computeruse-plugin}-{amd64,arm64}
                                        #  +build-arm64 +package-deb-arm64   (Phase A)
apps/runner/packaging/deb/DEBIAN/control # Architecture: ${ARCH} template    (Phase A)

docs/apps/infra-local-status.md         # +Lima runner section               (Phase E)
CLAUDE.md                               # "Lima Linux Testing" extension     (Phase E)
```

## 10. Hooks left for downstream work

These are not part of this branch but its design accommodates them so the
follow-up branch does not have to rework what we ship.

1. **Multi-Lima:** vmnet-shared gives each VM a unique IP — adding a second
   VM is `limactl start --name=runner-2 lima/runner.yaml`; ports do not
   collide.
2. **`LimaInfraProvider`:** the yaml is template-shaped and the bootstrap
   scripts take env-var inputs; the provider's job becomes "render N copies
   of the yaml with different names + run them through limactl".
3. **CI multi-arch release:** Phase A's `build-arm64` Nx targets are the
   ingredients for a future `matrix: [amd64, arm64]` job that uploads
   `boxlite-runner-v${VERSION}-linux-arm64.tar.gz`.

## 11. Verification check-points (collected from DoDs)

```bash
# Phase A
VERSION=0.0.0-dev nx build daemon --target=build-arm64
file dist/apps/daemon-arm64                    # ELF aarch64
nx build runner --target=build-arm64
file dist/apps/runner-arm64                    # ELF aarch64

# Phase B
make lima-up
limactl shell default -- ls -la /dev/kvm
limactl shell default -- ip -4 -o addr show
ping <vm-ip>                                   # from host
limactl shell default -- curl http://<host-gw-ip>:25000/v2/

# Phase C
limactl shell default -- /opt/boxlite/runner --version

# Phase D
limactl shell default -- systemctl status boxlite-runner
# Then via dashboard: create sandbox; open terminal; run:
#   cat /proc/cpuinfo | grep -i 'aarch64'

# Phase E
make lima-doctor                                # all green
```

## 12. Cross-references

- `docs/apps/cloud-mvp-plan.md` §5.2 Phase 4 — Lima runner role in the
  bigger Foundation arc
- `docs/apps/infra-vs-local-infra.md` §2 — why Lima over native HVF for
  production parity
- `docs/apps/infra-local-status.md` — current "M5 native" snapshot the
  Lima path is layered alongside (not replacing)
- `apps/infra/sst.config.ts:buildRunnerUserData` — the EC2 cloud-init
  script the Lima provision scripts mirror
- `apps/runner/README.md` — runner architecture (HTTP + background loops +
  FFI to Rust runtime); unchanged by this branch
- `memory/feedback_lima_nested_virt_required.md` — the nested-virt
  constraint

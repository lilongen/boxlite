#!/usr/bin/env bash
# Build the linux/arm64 BoxLite runner inside the Lima guest.
#
# Runs in `mode: user`. Sources from the writable mount at
# /home/${USER}.linux/boxlite (per the lima/runner.yaml mounts: block).
#
# All build state stays inside the VM under $HOME — never on the mounted
# host repo (per spec §8.6). The host's `git status` must remain clean
# after this script runs.
set -euo pipefail

REPO="/home/${USER}.linux/boxlite"
if [[ ! -d "$REPO" ]]; then
    echo "FATAL: repo mount not found at $REPO" >&2
    echo "Check apps/infra-local/lima/runner.yaml mounts: configuration." >&2
    exit 1
fi

# Keep build state OUT of the mounted host repo. Spec §8.6.
export NX_CACHE_DIRECTORY="${HOME}/.cache/nx"
export GOMODCACHE="${HOME}/go/pkg/mod"
export GOCACHE="${HOME}/.cache/go-build"
export CARGO_HOME="${HOME}/.cargo"
export CARGO_TARGET_DIR="${HOME}/cargo-target"
export YARN_CACHE_FOLDER="${HOME}/.cache/yarn"
mkdir -p "$NX_CACHE_DIRECTORY" "$GOMODCACHE" "$GOCACHE" "$CARGO_TARGET_DIR" "$YARN_CACHE_FOLDER"

# Skip computer-use plugin (the hack/ script is missing from the repo;
# the runner Dockerfile uses the same flag in CI — see commit
# 67c3af40-ish).
export SKIP_COMPUTER_USE_BUILD=true

# Rustup (per-user)
if [[ ! -x "${CARGO_HOME}/bin/rustc" ]]; then
    echo "== installing rustup =="
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path
fi
# shellcheck disable=SC1091
source "${CARGO_HOME}/env"
export PATH="/usr/local/go/bin:${CARGO_HOME}/bin:${PATH}"

cd "$REPO"

# 1. libboxlite.a (linux/arm64, KVM backend). The runner FFI binding
#    looks for sdks/go/libboxlite.a (see sdks/go/bridge_cgo_prebuilt.go).
#
# Submodule init is done on the *host* before lima-up: the worktree's
# .git is a file pointing at a path outside the mount, so `git submodule
# update` from inside Lima can't find the worktree metadata. Host
# operator must run `git submodule update --init --recursive` once.
echo "== checking submodules are populated =="
for d in src/deps/libkrun-sys/vendor/libkrun \
         src/deps/libkrun-sys/vendor/libkrunfw \
         src/deps/e2fsprogs-sys/vendor/e2fsprogs \
         src/deps/bubblewrap-sys/vendor/bubblewrap; do
    if [[ ! -f "${REPO}/${d}/Cargo.toml" && ! -f "${REPO}/${d}/Makefile" && ! -f "${REPO}/${d}/configure.ac" && ! -f "${REPO}/${d}/meson.build" ]]; then
        echo "FATAL: submodule ${d} not populated." >&2
        echo "On the host, run: git submodule update --init --recursive" >&2
        exit 1
    fi
done

echo "== building libboxlite.a (linux/arm64, KVM backend) =="
cargo build --release -p boxlite-c \
    --target-dir "${CARGO_TARGET_DIR}" 2>&1 | tail -10
cp "${CARGO_TARGET_DIR}/release/libboxlite.a" "${REPO}/sdks/go/libboxlite.a"
ls -la "${REPO}/sdks/go/libboxlite.a"

# 2. Yarn deps (Nx needs them)
echo "== yarn install (apps) =="
cd "${REPO}/apps"
yarn install --immutable 2>&1 | tail -10

# 3. Build daemon + computer-use + runner (arm64).
echo "== nx build daemon (arm64) =="
VERSION="${VERSION:-0.0.0-dev}" yarn nx run daemon:build-arm64
echo "== nx build computer-use (arm64) =="
VERSION="${VERSION:-0.0.0-dev}" SKIP_COMPUTER_USE_BUILD=true yarn nx run computer-use:build-arm64 --configuration=production || true
echo "== nx build runner (arm64) =="
VERSION="${VERSION:-0.0.0-dev}" yarn nx run runner:build-arm64

echo "== verifying outputs =="
file "${REPO}/dist/apps/daemon-arm64"
file "${REPO}/dist/apps/runner-arm64"

echo "== build-runner.sh done =="

#!/usr/bin/env bash
# Install the BoxLite runner build toolchain inside a Lima Linux guest.
# Idempotent: skips already-installed components.
#
# Runs in `mode: system` (as root). Rust is installed per-user later in
# build-runner.sh (rustup needs $HOME and is unhappy as root).
set -euo pipefail

GO_VERSION="${GO_VERSION:-1.25.4}"

echo "== apt packages =="
export DEBIAN_FRONTEND=noninteractive

# Lima cloud-init can briefly orphan /etc/environment, which causes
# install-info's post-install hook to error with `cannot open local`.
# Pre-create it to avoid that flake.
: > /etc/environment.tmp && mv -f /etc/environment.tmp /etc/environment 2>/dev/null || \
    touch /etc/environment

apt-get update -qq
# Use --fix-missing + retry, and don't let install-info's flake block us.
# If a single install fails, retry once after `apt-get -f install`.
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
    netcat-openbsd \
    ca-certificates \
    gnupg \
  || (apt-get -f install -y -qq && apt-get install -y -qq \
        build-essential pkg-config libseccomp-dev libssl-dev curl git \
        protobuf-compiler clang jq netcat-openbsd ca-certificates gnupg)

echo "== Go ${GO_VERSION} =="
if [[ ! -d /usr/local/go ]] \
   || [[ "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')" != "go${GO_VERSION}" ]]; then
    cd /tmp
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz" -o go.tgz
    rm -rf /usr/local/go
    tar -C /usr/local -xzf go.tgz
    rm go.tgz
fi
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

echo "== Node 22 + corepack =="
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
fi
corepack enable
corepack prepare yarn@stable --activate || true

echo "== /opt/boxlite directory =="
mkdir -p /opt/boxlite /var/lib/boxlite /var/log/boxlite /etc/boxlite

echo "== done =="
go version
node --version
yarn --version 2>&1 | head -1 || true

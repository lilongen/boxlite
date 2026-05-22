// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026

// EC2 user-data for boxlite-runner. Extracted from sst.config.ts so it can be
// reused by apps/infra/scripts/add-runner.ts when adding ad-hoc runners.

import { readFileSync } from "fs";
import { resolve } from "path";

export interface RunnerUserDataInput {
  apiUrl: string;
  token: string;
  registryUrl: string;
  runnerPort?: number;
  awsRegion?: string;
  /** Absolute path to repo root Cargo.toml. Defaults to <cwd>/../../Cargo.toml. */
  cargoTomlPath?: string;
  /**
   * Test-only flag. When true, downloads `boxlite-cli` so operators can use
   * it ad-hoc on the runner (debugging, exporting, inspecting boxes).
   *
   * NOTE: this used to also enable a `boxlite serve` systemd sidecar but that
   * approach was abandoned (see docs/runner-scaling/scale-down-design.md §11.5
   * — `BoxliteRuntime` requires an exclusive process lock on `BOXLITE_HOME`).
   * The CreateBackup path now uses in-process FFI bindings via libboxlite.a.
   */
  withBackupSidecar?: boolean;
  /** Sidecar listen port (only meaningful when withBackupSidecar=true). */
  sidecarPort?: number;
  /**
   * S3 bucket where `.boxlite` archives are stored during scale-down.
   * Only meaningful when withBackupSidecar=true. The runner reads this as
   * `BOXLITE_BACKUPS_BUCKET` and uses it for both PutObject (CreateBackup)
   * and GetObject (createFromBackupArchive).
   */
  backupsBucket?: string;
}

/** Returns base64-encoded user-data script. */
export function buildRunnerUserData(input: RunnerUserDataInput): string {
  const runnerPort = input.runnerPort ?? 3003;
  const awsRegion = input.awsRegion ?? "ap-southeast-1";
  const cargoToml = input.cargoTomlPath ?? resolve(process.cwd(), "../../Cargo.toml");

  const RUNNER_VERSION = readFileSync(cargoToml, "utf-8").match(/^version\s*=\s*"(.+?)"/m)![1];

  const registryHost = input.registryUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const withSidecar = input.withBackupSidecar === true;
  // input.sidecarPort is kept on the type for backward-compat with callers, but
  // unused since the systemd sidecar was retired (Option A — in-process FFI).
  const backupsBucket = input.backupsBucket ?? "";
  const backupsBucketEnv = withSidecar && backupsBucket ? `Environment=BOXLITE_BACKUPS_BUCKET=${backupsBucket}\n` : "";

  // Install `boxlite` CLI for ad-hoc operator use. The original sidecar
  // (`boxlite serve` as a systemd unit) was removed in the Option-A rewrite
  // because `BoxliteRuntime` cannot share `BOXLITE_HOME` between processes —
  // see docs/runner-scaling/scale-down-design.md §11.5. The runner now does
  // export/import in-process via libboxlite.a FFI; the CLI here is only
  // useful for manual debugging by operators.
  const sidecarFragment = withSidecar
    ? `
# ── boxlite CLI install (debug-only, no systemd service) ──────────────────
curl -fsSL "https://github.com/boxlite-ai/boxlite/releases/download/v${RUNNER_VERSION}/boxlite-cli-v${RUNNER_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar xz -C /usr/local/bin/
chmod +x /usr/local/bin/boxlite
echo "boxlite CLI installed at /usr/local/bin/boxlite (ad-hoc use; no service)"
`
    : "";

  const script = `#!/bin/bash
exec > /var/log/runner-setup.log 2>&1

# Wait for dpkg locks
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done

apt-get update
apt-get install -y curl

# Install Mountpoint for Amazon S3, used by volume mounts
MOUNT_S3_VERSION=1.20.0
MOUNT_S3_ARCH=x86_64
curl -fsSL "https://s3.amazonaws.com/mountpoint-s3-release/\${MOUNT_S3_VERSION}/\${MOUNT_S3_ARCH}/mount-s3-\${MOUNT_S3_VERSION}-\${MOUNT_S3_ARCH}.deb" -o /tmp/mount-s3.deb
apt-get install -y /tmp/mount-s3.deb
rm -f /tmp/mount-s3.deb

# Download prebuilt runner binary from GitHub Releases
curl -fsSL "https://github.com/boxlite-ai/boxlite/releases/download/v${RUNNER_VERSION}/boxlite-runner-v${RUNNER_VERSION}-linux-amd64.tar.gz" | tar xz -C /usr/local/bin/
chmod +x /usr/local/bin/boxlite-runner

# Get host IP via IMDSv2
IMDS_TOKEN=\$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
HOST_IP=\$(curl -s -H "X-aws-ec2-metadata-token: \$IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)

# Create systemd service for the BoxLite runner
cat > /etc/systemd/system/boxlite-runner.service << UNIT
[Unit]
Description=BoxLite Runner
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/boxlite-runner
Restart=always
RestartSec=5
TimeoutStopSec=60
Environment=BOXLITE_API_URL=${input.apiUrl.replace(/\/$/, "")}/api
Environment=BOXLITE_RUNNER_TOKEN=${input.token}
Environment=API_VERSION=2
Environment=API_PORT=${runnerPort}
Environment=RUNNER_DOMAIN=\$HOST_IP
Environment=BOXLITE_HOME_DIR=/var/lib/boxlite
Environment=INSECURE_REGISTRIES=${registryHost}
Environment=AWS_REGION=${awsRegion}
${backupsBucketEnv}
[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /var/lib/boxlite
systemctl daemon-reload
systemctl enable boxlite-runner
systemctl start boxlite-runner

echo "Runner setup complete"
${sidecarFragment}
`;
  return Buffer.from(script).toString("base64");
}

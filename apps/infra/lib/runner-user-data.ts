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
   * S3 bucket where `.boxlite` archives are stored during scale-down. When set,
   * surfaces as the runner's `BOXLITE_BACKUPS_BUCKET` env — the runner uses it
   * for both PutObject (CreateBackup) and GetObject (createFromBackupArchive).
   * Per-environment convention: caller resolves this once at provider construction
   * (e.g. from `BOXLITE_BACKUPS_BUCKET` env or `boxlite-volume-backups-${stage}`),
   * so it's NOT per-call. Omit to disable backup on this runner (legacy).
   */
  backupsBucket?: string;
}

/** Returns base64-encoded user-data script. */
export function buildRunnerUserData(input: RunnerUserDataInput): string {
  const runnerPort = input.runnerPort ?? 3003;
  const awsRegion = input.awsRegion ?? "ap-southeast-1";
  const cargoToml = input.cargoTomlPath ?? resolve(process.cwd(), "../../Cargo.toml");

  // Runner release version to download. Defaults to the repo's Cargo.toml
  // version; override with BOXLITE_RUNNER_VERSION to pin a specific release
  // (e.g. a fork test release whose version differs from the working tree).
  const RUNNER_VERSION =
    process.env.BOXLITE_RUNNER_VERSION ??
    readFileSync(cargoToml, "utf-8").match(/^version\s*=\s*"(.+?)"/m)![1];

  // GitHub repo the runner/CLI release assets are pulled from. Defaults to the
  // canonical `boxlite-ai/boxlite`; override with BOXLITE_RUNNER_RELEASE_REPO to
  // pull a runner built on a fork (e.g. a backup-capable test release) without
  // touching the canonical release.
  const releaseRepo = process.env.BOXLITE_RUNNER_RELEASE_REPO ?? "boxlite-ai/boxlite";

  const registryHost = input.registryUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const backupsBucket = input.backupsBucket ?? "";
  // Always set BOXLITE_BACKUPS_BUCKET when a bucket is configured for this env.
  // Every prod runner enables backup by default; absence is only the legacy
  // "no backup configured" fallback (returns "bucket not set" from CreateBackup).
  const backupsBucketEnv = backupsBucket ? `Environment=BOXLITE_BACKUPS_BUCKET=${backupsBucket}\n` : "";

  // Always install the `boxlite` CLI for ad-hoc operator use (export/inspect).
  // It's NOT a service — the runner does backup/restore in-process via the
  // libboxlite.a FFI (the original `boxlite serve` systemd sidecar was retired
  // because BoxliteRuntime needs an exclusive lock on BOXLITE_HOME — see
  // docs/runner-scaling/scale-down-design.md §11.5).
  const cliInstallFragment = `
# ── boxlite CLI install (debug-only, no systemd service) ──────────────────
curl -fsSL "https://github.com/${releaseRepo}/releases/download/v${RUNNER_VERSION}/boxlite-cli-v${RUNNER_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar xz -C /usr/local/bin/
chmod +x /usr/local/bin/boxlite
echo "boxlite CLI installed at /usr/local/bin/boxlite (ad-hoc use; no service)"
`;

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
curl -fsSL "https://github.com/${releaseRepo}/releases/download/v${RUNNER_VERSION}/boxlite-runner-v${RUNNER_VERSION}-linux-amd64.tar.gz" | tar xz -C /usr/local/bin/
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
${cliInstallFragment}
`;
  return Buffer.from(script).toString("base64");
}

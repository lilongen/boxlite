#!/usr/bin/env bash
# Deploy locally-built (patched) boxlite-runner + boxlite-cli sidecar to a
# specific test runner EC2 via S3 presigned URL + SSM Run Command.
#
# Why this exists: the scale-down sidecar path needs both binaries to ship
# together — the runner's stubs.go talks HTTP to the boxlite-cli sidecar, and
# the sidecar's /import requires the matching `?id=` query param patch. The
# normal release-based upgrade script (runner-update-binary.sh) pulls from
# GitHub Releases and would deploy unpatched code.
#
# Usage:
#   scripts/deploy/deploy-patched-scaledown-binaries.sh <instance-id>
#
# Prereqs:
#   - target/release/boxlite-runner   (CGO Linux amd64 patched runner)
#   - target/release/boxlite          (Rust patched CLI with ?id= on /import)
#   - AWS_PROFILE with PutObject + ssm:SendCommand for that instance
#
# Idempotent: replaces both binaries, restarts both systemd units.

set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
S3_BUCKET="${BOXLITE_BACKUPS_BUCKET:-boxlite-volume-backups-dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

INSTANCE_ID="${1:-}"
if [[ -z "$INSTANCE_ID" ]]; then
  echo "Usage: $0 <ec2-instance-id>" >&2
  exit 2
fi

RUNNER_BIN="$REPO_ROOT/target/release/boxlite-runner"
SIDECAR_BIN="$REPO_ROOT/target/release/boxlite"
for f in "$RUNNER_BIN" "$SIDECAR_BIN"; do
  [[ -f "$f" ]] || { echo "missing binary: $f" >&2; exit 2; }
done

KEY_PREFIX="scaledown-deploy/$(date -u +%Y%m%d-%H%M%S)"
RUNNER_KEY="$KEY_PREFIX/boxlite-runner"
SIDECAR_KEY="$KEY_PREFIX/boxlite"

echo "==> Uploading binaries to s3://$S3_BUCKET/$KEY_PREFIX/"
aws s3 cp "$RUNNER_BIN" "s3://$S3_BUCKET/$RUNNER_KEY" --region "$AWS_REGION" >/dev/null
aws s3 cp "$SIDECAR_BIN" "s3://$S3_BUCKET/$SIDECAR_KEY" --region "$AWS_REGION" >/dev/null

RUNNER_URL=$(aws s3 presign "s3://$S3_BUCKET/$RUNNER_KEY" --region "$AWS_REGION" --expires-in 3600)
SIDECAR_URL=$(aws s3 presign "s3://$S3_BUCKET/$SIDECAR_KEY" --region "$AWS_REGION" --expires-in 3600)

echo "==> Sending SSM RunCommand to $INSTANCE_ID"

# Build a remote script that base64-decodes the URLs (which contain & and =
# from presigning). This avoids brittle shell-quoting through SSM RunCommand.
RUNNER_URL_B64=$(printf '%s' "$RUNNER_URL"  | base64 | tr -d '\n')
SIDECAR_URL_B64=$(printf '%s' "$SIDECAR_URL" | base64 | tr -d '\n')

REMOTE_SCRIPT=$(cat <<REMOTE
set -e
RUNNER_URL=\$(printf '%s' '$RUNNER_URL_B64' | base64 -d)
SIDECAR_URL=\$(printf '%s' '$SIDECAR_URL_B64' | base64 -d)

echo "[remote] stopping + disabling services"
systemctl stop boxlite-runner.service 2>/dev/null || true
# Disable the sidecar: Option-A rewrite means the runner does export/import
# in-process. Two BoxliteRuntime processes would fight for the BOXLITE_HOME lock.
systemctl stop boxlite-serve.service 2>/dev/null || true
systemctl disable boxlite-serve.service 2>/dev/null || true

echo "[remote] downloading runner"
curl -fsSL -o /usr/local/bin/boxlite-runner.new "\$RUNNER_URL"
chmod +x /usr/local/bin/boxlite-runner.new
mv -f /usr/local/bin/boxlite-runner.new /usr/local/bin/boxlite-runner

echo "[remote] downloading sidecar (still installed for ad-hoc CLI usage)"
curl -fsSL -o /usr/local/bin/boxlite.new "\$SIDECAR_URL"
chmod +x /usr/local/bin/boxlite.new
mv -f /usr/local/bin/boxlite.new /usr/local/bin/boxlite

if ! grep -q 'BOXLITE_BACKUPS_BUCKET=' /etc/systemd/system/boxlite-runner.service; then
  echo "[remote] injecting BOXLITE_BACKUPS_BUCKET into runner unit"
  sed -i '/\[Install\]/i Environment=BOXLITE_BACKUPS_BUCKET=$S3_BUCKET' /etc/systemd/system/boxlite-runner.service
fi

systemctl daemon-reload
systemctl start boxlite-runner.service

sleep 3
echo "[remote] runner status: \$(systemctl is-active boxlite-runner.service)"
REMOTE
)

# Pipe through jq to JSON-encode the command (handles all special chars).
PARAMS_JSON=$(jq -Rsa --arg cmd "$REMOTE_SCRIPT" '{commands:[$cmd]}' </dev/null)

CMD_ID=$(aws ssm send-command --region "$AWS_REGION" \
  --document-name "AWS-RunShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --comment "scale-down: deploy patched boxlite + boxlite-runner" \
  --parameters "$PARAMS_JSON" \
  --query 'Command.CommandId' --output text)

echo "    SSM command: $CMD_ID"
aws ssm wait command-executed --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" || true

STATUS=$(aws ssm get-command-invocation --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query 'Status' --output text)
echo "==> Status: $STATUS"
aws ssm get-command-invocation --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text

if [[ "$STATUS" != "Success" ]]; then
  echo
  echo "==> stderr:"
  aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query 'StandardErrorContent' --output text
  exit 1
fi

echo "==> Cleaning up S3 artifacts"
aws s3 rm "s3://$S3_BUCKET/$RUNNER_KEY" --region "$AWS_REGION" >/dev/null || true
aws s3 rm "s3://$S3_BUCKET/$SIDECAR_KEY" --region "$AWS_REGION" >/dev/null || true

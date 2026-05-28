#!/usr/bin/env bash
# Wrapper for add-shared-runner.ts targeting the boxlite/dev stack.
# Discovers AWS infra values (subnet, IAM profile) from the existing default
# runner EC2, and exports BOXLITE_API_URL / BOXLITE_REGISTRY_URL.
#
# Usage:
#   ./scripts/add-shared-runner-dev.sh --yes
#   ./scripts/add-shared-runner-dev.sh --dry-run
#   ./scripts/add-shared-runner-dev.sh --region-id us --name runner-shared-001 --yes
#
# Required env (set before running):
#   BOXLITE_ADMIN_API_KEY  ADMIN bearer token (the API's ADMIN_API_KEY env;
#                          surfaced once in the API container's startup log,
#                          also in AWS Secrets Manager as 'AdminApiKey').
#
# Prerequisites:
#   - AWS_PROFILE configured (boxlite dev account)
#   - aws / jq / npx
#   - yarn install in apps/infra/

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$DIR/.." && pwd)"

# ── defaults (override via env) ──────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
BOXLITE_STAGE="${BOXLITE_STAGE:-dev}"
STACK_DOMAIN="${STACK_DOMAIN:-dev.boxlite.ai}"
RUNNER_TAG_NAME="${RUNNER_TAG_NAME:-boxlite-runner}"
export AWS_REGION BOXLITE_STAGE STACK_DOMAIN RUNNER_TAG_NAME

echo "──────────────────────────────────────────────────────────────────"
echo " add-shared-runner-dev.sh   stack=$BOXLITE_STAGE   aws=$AWS_REGION"
echo "──────────────────────────────────────────────────────────────────"

# ── 0. preflight ─────────────────────────────────────────────────────────────
missing_tools=()
for t in aws jq npx; do
  if ! command -v "$t" >/dev/null 2>&1; then missing_tools+=("$t"); fi
done
if [ ${#missing_tools[@]} -gt 0 ]; then
  echo "[0/3] Missing required tools: ${missing_tools[*]}"
  for t in "${missing_tools[@]}"; do
    case "$t" in
      jq)  echo "      jq: brew install jq" ;;
      aws) echo "      aws: brew install awscli" ;;
      npx) echo "      npx: install Node.js (brew install node) and run 'yarn install' in apps/infra/" ;;
    esac
  done
  exit 2
fi

if [ -z "${BOXLITE_ADMIN_API_KEY:-}" ]; then
  echo "[0/3] ERROR: BOXLITE_ADMIN_API_KEY env var not set."
  echo "       The ADMIN token is auto-generated at first deploy and printed once in"
  echo "       the API container's startup log: 'Admin user created with API key: ...'"
  echo "       It is also stored as 'AdminApiKey' in AWS Secrets Manager (SST random)."
  echo "         export BOXLITE_ADMIN_API_KEY=<token>"
  exit 2
fi

echo "[0/3] Tools OK; BOXLITE_ADMIN_API_KEY present."

# ── 1. mirror infra values from an existing runner EC2 ──────────────────────
echo "[1/3] Discovering subnet + IAM profile from any 'boxlite-runner*' EC2..."
discover_ec2() {
  local filter_val="$1"
  aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$filter_val" \
              "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].{Id:InstanceId,Name:Tags[?Key==`Name`].Value|[0],SubnetId:SubnetId,Profile:IamInstanceProfile.Arn}' \
    --output json 2>/dev/null || echo "{}"
}
BASTION_JSON=$(discover_ec2 "$RUNNER_TAG_NAME")
SUBNET_ID=$(echo "$BASTION_JSON" | jq -r '.SubnetId // empty')
PROFILE_ARN=$(echo "$BASTION_JSON" | jq -r '.Profile // empty')
SOURCE_NAME=$(echo "$BASTION_JSON" | jq -r '.Name // empty')

if [ -z "$SUBNET_ID" ] || [ -z "$PROFILE_ARN" ]; then
  echo "       ↳ no exact match for Name=$RUNNER_TAG_NAME; trying prefix 'boxlite-runner*'..."
  BASTION_JSON=$(discover_ec2 "boxlite-runner*")
  SUBNET_ID=$(echo "$BASTION_JSON" | jq -r '.SubnetId // empty')
  PROFILE_ARN=$(echo "$BASTION_JSON" | jq -r '.Profile // empty')
  SOURCE_NAME=$(echo "$BASTION_JSON" | jq -r '.Name // empty')
fi

if [ -z "$SUBNET_ID" ] || [ -z "$PROFILE_ARN" ]; then
  echo "       ERROR: no running EC2 with tag Name=$RUNNER_TAG_NAME or Name=boxlite-runner* in $AWS_REGION."
  echo "              Either:"
  echo "                - Set RUNNER_TAG_NAME=<exact-name>"
  echo "                - Pass --subnet-id / --instance-profile-name directly to add-shared-runner.ts"
  exit 2
fi

PROFILE_NAME="${PROFILE_ARN##*/}"
echo "       ✓ mirroring '$SOURCE_NAME': subnet=$SUBNET_ID  profile=$PROFILE_NAME"

# ── 2. derive API URLs from STACK_DOMAIN ─────────────────────────────────────
echo "[2/3] Deriving API + registry URLs from STACK_DOMAIN=${STACK_DOMAIN}..."
export BOXLITE_API_URL="https://api.$STACK_DOMAIN"

# Registry: discover the SnapshotManager ALB DNS rather than using the Cloudflare
# hostname. snapshot.ref values stored in the API DB use the ALB DNS verbatim, so
# the runner's INSECURE_REGISTRIES (derived from this URL) must match it exactly
# or lazy-pull at sandbox create fails with cert errors on the *.elb.amazonaws.com
# hostname.
SNAPSHOT_ALB_DNS=$(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
  --query 'LoadBalancers[?contains(DNSName, `napshotMana`)]|[0].DNSName' \
  --output text 2>/dev/null)
if [ -z "$SNAPSHOT_ALB_DNS" ] || [ "$SNAPSHOT_ALB_DNS" = "None" ]; then
  echo "       ↳ ALB lookup failed, falling back to STACK_DOMAIN host"
  export BOXLITE_REGISTRY_URL="https://snapshot-manager.$STACK_DOMAIN"
else
  export BOXLITE_REGISTRY_URL="https://$SNAPSHOT_ALB_DNS"
fi
echo "       ✓ api=$BOXLITE_API_URL"
echo "       ✓ registry=$BOXLITE_REGISTRY_URL"

# Per-environment convention: one backups bucket per stack — matches the SST
# resource name. Honour an explicit override if the caller already set
# BOXLITE_BACKUPS_BUCKET. Skipping this is fine; the runner just won't have
# backup configured (the same as before this script auto-set it).
export BOXLITE_BACKUPS_BUCKET="${BOXLITE_BACKUPS_BUCKET:-boxlite-volume-backups-${BOXLITE_STAGE}}"
echo "       ✓ backups bucket=$BOXLITE_BACKUPS_BUCKET"

# ── 3. invoke add-shared-runner.ts ───────────────────────────────────────────
echo "[3/3] Running add-shared-runner.ts…"
echo "──────────────────────────────────────────────────────────────────"
cd "$INFRA_DIR"
npx tsx scripts/add-shared-runner.ts \
  --subnet-id "$SUBNET_ID" \
  --instance-profile-name "$PROFILE_NAME" \
  "$@"

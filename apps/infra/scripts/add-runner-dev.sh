#!/usr/bin/env bash
# Wrapper for add-runner.ts targeting the boxlite/dev stack.
# Discovers AWS infra values (subnet, IAM profile) from the existing default
# runner EC2, and exports BOXLITE_API_URL / BOXLITE_REGISTRY_URL. No SSM
# tunnel, no DB access — everything goes through the REST API on apps/api.
#
# Usage:
#   ./scripts/add-runner-dev.sh --orgid <uuid> --yes
#   ./scripts/add-runner-dev.sh --orgid <uuid> --dry-run
#
# Required env (set before running):
#   BOXLITE_API_TOKEN  bearer token with WRITE_REGIONS + WRITE_RUNNERS perms
#                      on the target org (issue from dashboard or via OIDC)
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
RUNNER_TAG_NAME="${RUNNER_TAG_NAME:-boxlite-runner}"   # existing EC2 we mirror config from
export AWS_REGION BOXLITE_STAGE STACK_DOMAIN RUNNER_TAG_NAME

echo "──────────────────────────────────────────────────────────────────"
echo " add-runner-dev.sh   stack=$BOXLITE_STAGE   aws=$AWS_REGION"
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

if [ -z "${BOXLITE_API_TOKEN:-}" ]; then
  echo "[0/3] ERROR: BOXLITE_API_TOKEN env var not set."
  echo "       Issue a token from the dashboard (with WRITE_REGIONS + WRITE_RUNNERS"
  echo "       perms on the target org) and:"
  echo "         export BOXLITE_API_TOKEN=<token>"
  exit 2
fi

echo "[0/3] Tools OK; BOXLITE_API_TOKEN present."

# ── 1. mirror infra values from an existing runner EC2 ──────────────────────
# Try exact match first (the original sst-deployed default runner). Fall back
# to prefix match (any 'boxlite-runner*' the script itself may have created).
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
  echo "                - Pass --subnet-id / --instance-profile-name directly to add-runner.ts"
  exit 2
fi

PROFILE_NAME="${PROFILE_ARN##*/}"   # last path segment of the ARN
echo "       ✓ mirroring '$SOURCE_NAME': subnet=$SUBNET_ID  profile=$PROFILE_NAME"

# ── 2. derive API URLs from STACK_DOMAIN ─────────────────────────────────────
echo "[2/3] Deriving API + registry URLs from STACK_DOMAIN=${STACK_DOMAIN}..."
export BOXLITE_API_URL="https://api.$STACK_DOMAIN"
export BOXLITE_REGISTRY_URL="https://snapshot-manager.$STACK_DOMAIN"
echo "       ✓ api=$BOXLITE_API_URL"
echo "       ✓ registry=$BOXLITE_REGISTRY_URL"

# ── 3. invoke add-runner.ts ──────────────────────────────────────────────────
echo "[3/3] Running add-runner.ts…"
echo "──────────────────────────────────────────────────────────────────"
cd "$INFRA_DIR"
npx tsx scripts/add-runner.ts \
  --subnet-id "$SUBNET_ID" \
  --instance-profile-name "$PROFILE_NAME" \
  "$@"

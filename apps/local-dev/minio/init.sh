#!/bin/sh
# One-shot MinIO bootstrap: wait for the server, alias it, create the default
# bucket. Exit 0 on idempotent success so docker compose `depends_on:
# condition: service_completed_successfully` can gate API startup on this.
set -eu

until mc alias set local "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1; do
  echo "[minio-init] waiting for MinIO at $S3_ENDPOINT ..."
  sleep 1
done

if mc ls "local/$S3_DEFAULT_BUCKET" >/dev/null 2>&1; then
  echo "[minio-init] bucket '$S3_DEFAULT_BUCKET' already exists — nothing to do."
else
  mc mb "local/$S3_DEFAULT_BUCKET"
  echo "[minio-init] created bucket '$S3_DEFAULT_BUCKET'"
fi

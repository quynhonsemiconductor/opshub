#!/usr/bin/env bash
#
# LocalStack bootstrap — provisions the S3 bucket the OpsHub API expects, so presigned
# uploads can be exercised locally instead of failing against a bucket nobody owns.
#
# Runs automatically via the /etc/localstack/init/ready.d hook every time LocalStack
# becomes ready (mounted from ./scripts/localstack in docker-compose.dev.yml). Mirrors how
# db/init/ bootstraps Postgres.
#
# Idempotent: create-bucket's BucketAlreadyOwnedByYou is swallowed explicitly.
#
# THIS SCRIPT USED TO PROVISION AN SQS QUEUE AND DLQ. The domain-event outbox that fed
# them had no consumer, so the whole leg was removed (migration 0013) and the queue went
# with it. What remains is object storage, which StorageService genuinely uses in every
# environment.
#
# Names / region are kept in sync with .env (S3_FILES_BUCKET).
set -euo pipefail

# `awslocal` exists only inside the LocalStack container, where the init hook runs it.
# Kept working under plain `aws` too, so the script can be run by hand from the host
# against the same endpoint when a bucket needs re-creating mid-session.
if command -v awslocal >/dev/null 2>&1; then
  aws_cmd() { awslocal "$@"; }
else
  aws_cmd() { aws --endpoint-url "${AWS_ENDPOINT_URL:-http://localhost:4566}" "$@"; }
fi

REGION="ap-southeast-1"
BUCKET="opshub-files-dev"
# Vite dev-server origin — the SPA PUTs directly to the bucket from here.
WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:5174}"

echo "[localstack-init] provisioning S3…"

# create-bucket is not idempotent the way create-queue is: it returns
# BucketAlreadyOwnedByYou on re-run, which `set -e` would otherwise treat as
# fatal on every restart.
aws_cmd s3api create-bucket \
  --bucket "$BUCKET" \
  --region "$REGION" \
  --create-bucket-configuration "LocationConstraint=$REGION" \
  >/dev/null 2>&1 || true

# CORS mirrors the rules the app-bucket module applies in real AWS.
#
# EVERY SIGNED HEADER MUST BE LISTED. `StorageService.presignUpload` signs
# content-type, content-length and content-disposition, and returns all of them
# in `requiredHeaders` for the client to send. The comment that used to sit here
# claimed Content-Type was the only signed header; it was wrong, so the preflight
# refused Content-Disposition and every browser upload died with an opaque
# `net::ERR_FAILED` — no status, no CORS headers, nothing to read. Measured from a
# real browser, and the same gap was in infra/modules/stack/main.tf.
#
# Content-Length stays off the list deliberately: the browser sets it itself and it
# is a forbidden header name, so CORS never governs it.
aws_cmd s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "{
  \"CORSRules\": [{
    \"AllowedMethods\": [\"PUT\", \"GET\", \"HEAD\"],
    \"AllowedOrigins\": [\"${WEB_ORIGIN}\"],
    \"AllowedHeaders\": [\"Content-Type\", \"Content-Disposition\"],
    \"ExposeHeaders\": [\"ETag\"],
    \"MaxAgeSeconds\": 3600
  }]
}" >/dev/null

# Abort incomplete multipart uploads so abandoned uploads do not accrue storage.
aws_cmd s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}
    }]
  }' >/dev/null

echo "[localstack-init]   bucket ready: $BUCKET"
echo "[localstack-init] done."

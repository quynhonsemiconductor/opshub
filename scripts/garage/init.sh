#!/usr/bin/env bash
#
# One-shot setup of the local Garage node: layout, a fixed local-dev key, the buckets, their grant, lifecycle and CORS.
# Idempotent: every step checks before it changes anything. It exits non-zero on any failure, so a broken bucket or CORS rule is
# visible in the exit status instead of at the first upload.
#
# Local stand-in for the bucket OpsHub uses in AWS. Buckets are private to the key; the browser reaches them only through
# presigned URLs the API signs. Production never sees this file.
set -euo pipefail

ADMIN="http://garage:3903"
AUTH="Authorization: Bearer ${GARAGE_ADMIN_TOKEN}"
BUCKETS="${BUCKETS:-opshub-files-dev opshub-files-test}"
WEB_ORIGINS="${WEB_ORIGINS:-http://localhost:5174,http://127.0.0.1:5174}"
# Must match s3_region in docker/garage/garage.toml, which is the region the API signs with.
export AWS_ACCESS_KEY_ID="${STORAGE_ACCESS_KEY_ID}" AWS_SECRET_ACCESS_KEY="${STORAGE_SECRET_ACCESS_KEY}" AWS_DEFAULT_REGION=auto

# The amazon/aws-cli image has no python3, so pull fields out of Garage's compact JSON with grep and sed.
string_field() { grep -o "\"$1\" *: *\"[^\"]*\"" | head -1 | sed 's/.*: *"\([^"]*\)"$/\1/'; }
number_field() { grep -o "\"$1\" *: *[0-9]*" | head -1 | sed 's/.*: *//'; }

echo "[garage-init] waiting for the node…"
for _ in $(seq 1 60); do
  curl -sf -H "$AUTH" "$ADMIN/v1/status" >/dev/null && break
  sleep 2
done
curl -sf -H "$AUTH" "$ADMIN/v1/status" >/dev/null || { echo "[garage-init] node did not answer" >&2; exit 1; }

node_id=$(curl -sf -H "$AUTH" "$ADMIN/v1/status" | string_field node)
layout_version=$(curl -sf -H "$AUTH" "$ADMIN/v1/layout" | number_field version)
if [ "$layout_version" = "0" ]; then
  curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
    -d "[{\"id\":\"$node_id\",\"zone\":\"dc1\",\"capacity\":1073741824,\"tags\":[]}]" "$ADMIN/v1/layout" >/dev/null
  curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' -d '{"version":1}' "$ADMIN/v1/layout/apply" >/dev/null
  echo "[garage-init]   layout applied"
fi

if [ "$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$ADMIN/v1/key?id=$STORAGE_ACCESS_KEY_ID")" != "200" ]; then
  curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"name\":\"local-dev\",\"accessKeyId\":\"$STORAGE_ACCESS_KEY_ID\",\"secretAccessKey\":\"$STORAGE_SECRET_ACCESS_KEY\"}" \
    "$ADMIN/v1/key/import" >/dev/null
  echo "[garage-init]   key imported"
fi

# CORS, one rule per origin: Garage joins origins in a single rule into one header, which browsers refuse. Garage compares the
# allowed header names case-sensitively against the lowercase names a browser sends, so they are written lowercase here. The list
# is every header the presigned PUT signs (StorageService.presignUpload): content-type and content-disposition.
rules=""
IFS=',' read -r -a origins <<< "$WEB_ORIGINS"
for origin in "${origins[@]}"; do
  rules="${rules}{\"AllowedOrigins\":[\"${origin}\"],\"AllowedMethods\":[\"PUT\",\"GET\",\"HEAD\"],\"AllowedHeaders\":[\"content-type\",\"content-disposition\"],\"ExposeHeaders\":[\"ETag\"],\"MaxAgeSeconds\":3600},"
done
cors="{\"CORSRules\":[${rules%,}]}"

# Abort incomplete multipart uploads after 7 days, as the AWS bucket does.
lifecycle='{"Rules":[{"ID":"abort-incomplete-multipart","Status":"Enabled","Filter":{"Prefix":""},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'

for bucket in $BUCKETS; do
  bucket_id=$(curl -sf -H "$AUTH" "$ADMIN/v1/bucket?globalAlias=$bucket" 2>/dev/null | string_field id || true)
  if [ -z "$bucket_id" ]; then
    bucket_id=$(curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
      -d "{\"globalAlias\":\"$bucket\"}" "$ADMIN/v1/bucket" | string_field id)
    echo "[garage-init]   bucket created: $bucket"
  fi
  curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"bucketId\":\"$bucket_id\",\"accessKeyId\":\"$STORAGE_ACCESS_KEY_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" \
    "$ADMIN/v1/bucket/allow" >/dev/null
  aws --endpoint-url http://garage:3900 s3api put-bucket-cors --bucket "$bucket" --cors-configuration "$cors"
  aws --endpoint-url http://garage:3900 s3api put-bucket-lifecycle-configuration --bucket "$bucket" --lifecycle-configuration "$lifecycle"
done

# Prove it, the way a browser asks: a preflight from each origin, for the headers the upload sends, must get that origin back.
for bucket in $BUCKETS; do
  for origin in "${origins[@]}"; do
    got=$(curl -s -o /dev/null -D - -X OPTIONS -H "Origin: $origin" -H "Access-Control-Request-Method: PUT" \
      -H "Access-Control-Request-Headers: content-type,content-disposition" \
      "http://garage:3900/$bucket/probe" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
    if [ "$got" != "$origin" ]; then
      echo "[garage-init] CORS check failed for $bucket from $origin (got '$got')" >&2
      exit 1
    fi
  done
  echo "[garage-init]   bucket ready: $bucket (CORS for ${WEB_ORIGINS})"
done

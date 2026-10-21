// opshub · production — DESTROYED (owner decision, 2026-10-21)
//
// opshub never served production traffic (no prod ever ran; the environment was
// provisioned, idled and weekly-stopped), and the on-prem plan gives opshub no
// prod at all. This file once composed the full stack via ../../modules/stack;
// it is now deliberately EMPTY: the next apply-prod run plans the removal of
// every resource in `opshub/prod/terraform.tfstate` and applies it, through the
// SAME gates as any prod change — the `production` Environment reviewer,
// plan-guard, destructive-guard and `.allow-data-destroy` (this directory).
//
// Owner runbook, IN ORDER, before that apply:
//   1. Final manual RDS snapshot + wait for it to be available:
//        export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1 AWS_PAGER=""
//        aws rds create-db-snapshot \
//          --db-instance-identifier opshub-prod-db \
//          --db-snapshot-identifier opshub-prod-db-final-2026-10-21 \
//          --profile qnsc-admin
//        aws rds wait db-snapshot-completed \
//          --db-instance-identifier opshub-prod-db \
//          --db-snapshot-identifier opshub-prod-db-final-2026-10-21 \
//          --profile qnsc-admin
//   2. Remove deletion protection (a protected instance refuses the destroy):
//        aws rds modify-db-instance --db-instance-identifier opshub-prod-db \
//          --no-deletion-protection --apply-immediately --profile qnsc-admin
//   3. Check the uploads bucket is empty (`force_destroy` was never set):
//        aws s3 ls s3://<bucket from `tofu state list` / outputs> --profile qnsc-admin
//      If objects exist, the owner decides where they go BEFORE applying.
//   4. Push the teardown tag and approve the `production` environment. The run
//      prints every destroy; the SNS topic `opshub-prod-alarms`, SES set, SQS,
//      CloudWatch alarms, secrets (30-day recovery window), the Pages project,
//      DNS records and the tunnel go with it.
//
// The empty state file `opshub/prod/terraform.tfstate` stays in the bucket until
// the AWS wind-down (the platform plan's §15.3) deletes it with the rest.
// `develop` and `_shared` are UNTOUCHED — they run opshub dev on-prem after the
// move.
//
// The known drift on this stack — the never-read `jwt-private` and
// `graph-client-secret` secrets and the ALB target group the tunnel cutover
// orphaned — is moot here: destroy does not consult drift.

terraform {
  backend "s3" {
    bucket         = "qnsc-tofu-state"
    key            = "opshub/prod/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "qnsc-tofu-locks"
  }
}

# Intentionally no providers and no resources: an empty configuration against
# this backend is a full-state prune.

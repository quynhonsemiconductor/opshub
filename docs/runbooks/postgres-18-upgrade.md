# PostgreSQL 17 → 18 in place: opshub production

Status: DRAFT. Not for merge until the owner names the release window. Merging applies `infra/live/prod`.

Scope: `opshub-prod` RDS (PostgreSQL 17.9 → 18.x, major pin `18`, auto minor upgrades on). Opshub production has no ElastiCache cluster (`cache.enabled = false`), so there is no cache step here.

Owner: decide the window, announce it, and run every command below in your own terminal with `--profile qnsc-admin`. The default profile on this machine is another account.

## 0. Preconditions

- The develop upgrade (`opshub-develop`) completed and was verified: `/v1/readyz`, sign-in, the worker, and the migrations on 18.
- #434 (local and CI pins) and #436 (stack wiring, develop) are merged, and tf-modules `rds-v2.4.0` exists.
- Read-only check of the instance (name the profile):
  ```
  aws rds describe-db-instances --profile qnsc-admin --region ap-southeast-1 --db-instance-identifier opshub-prod --query 'DBInstances[0].[EngineVersion,DBParameterGroups[0].DBParameterGroupName,AutoMinorVersionUpgrade,length(PendingModifiedValues)]'
  ```

## 1. Manual snapshot (mandatory, before any change)

```
aws rds create-db-snapshot --profile qnsc-admin --region ap-southeast-1 --db-instance-identifier opshub-prod --db-snapshot-identifier opshub-prod-pre-pg18-$(date -u +%Y%m%d%H%M)
aws rds wait db-snapshot-available --profile qnsc-admin --region ap-southeast-1 --db-snapshot-identifier <the name above>
```

Record the snapshot identifier in the release notes. It is the rollback.

## 2. Plan, read it, then apply

```
AWS_PROFILE=qnsc-admin tofu -chdir=infra/live/prod plan -out=prod.tfplan
AWS_PROFILE=qnsc-admin tofu -chdir=infra/live/prod show prod.tfplan
```

Expected:
- `module.rds.aws_db_parameter_group.this[0]` replaced: `opshub-prod-pg17` → `opshub-prod-pg18`, family `postgres17` → `postgres18`, create-before-destroy.
- `module.rds.aws_db_instance.this` in-place: `engine_version` 17.9 → 18.x, both flags true.
- Stop, and do not apply, if the instance is `must be replaced`, or anything is destroyed besides the old parameter group.

Apply (inside the window): `AWS_PROFILE=qnsc-admin tofu -chdir=infra/live/prod apply prod.tfplan`.

## 3. Verify

- `aws rds describe-db-instances ... --db-instance-identifier opshub-prod` → 18.x, `opshub-prod-pg18`, no pending values.
- Migrator runs clean on 18; `/v1/readyz` postgres up; sign-in; worker.
- Smoke test the main read and write paths named in the release notes.

## 4. Rollback

Restore the snapshot from step 1 to a new instance, repoint `opshub-prod` (owner-run, local apply with `-replace` if needed, same style as rova #729). An in-place major upgrade cannot be undone on the same instance. Keep the snapshot until the next release window.

## 5. Follow-up

A PR sets `allow_major_version_upgrade` and `apply_immediately` back to false. It is not part of this change.

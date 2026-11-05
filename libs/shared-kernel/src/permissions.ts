/**
 * Re-export of the canonical permission catalogue so application code imports it
 * as `@shared-kernel` like every other shared type, without reaching into `db/`.
 *
 * The catalogue itself lives in `db/permissions.catalog.ts` because the migrator
 * image bundles `db/**` only and the seed must read the same definitions the
 * guards do. This file is the seam, not a second source: everything here is a
 * re-export, so there is nothing to keep in sync.
 *
 * `constants.ts` used to declare its own `PERMISSION` map with a different
 * vocabulary (`assets.view` where the database has `asset.read`). Nothing
 * imported it, which is the only reason it never caused an outage — a single
 * `PERMISSION.ASSETS_VIEW` would have gated a route on a code no role grants.
 * That map is gone; this is the only `PERMISSION` in the codebase.
 */
export {
  PERMISSION,
  PERMISSION_DESCRIPTIONS,
  WILDCARD_PERMISSION,
  GROUP,
  GROUP_NAMES,
  GROUP_PERMISSIONS,
  moduleOf,
  permissionModules,
  permissionGrants,
} from '@db/permissions.catalog';

export type { Permission, GroupKey } from '@db/permissions.catalog';

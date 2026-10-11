import { MS_PER_HOUR } from '@shared-kernel';

/**
 * The `ExclusiveJob` lock names and TTLs of the long Graph runs. The scheduled cron and the queued task
 * take THE SAME lock, so a scan the cron started and a scan someone asked for cannot overlap (two scans
 * racing would raise duplicate findings).
 */
export const GRAPH_LOCK = {
  DEVICE_SYNC: { name: 'compliance-device-sync', ttlMs: 25 * 60_000 },
  SHADOW_IT: { name: 'compliance-shadow-it', ttlMs: 5 * MS_PER_HOUR },
  POSTURE: { name: 'security-posture-sync', ttlMs: 23 * MS_PER_HOUR },
} as const;

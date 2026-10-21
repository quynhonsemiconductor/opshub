import { Injectable, Logger } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
import { complianceFindings, graphSyncState } from '../../../../../db/schema';
import { GraphClientService } from '../graph-client.service';

/** Minimal typed subset of a Graph managedDevice response. */
interface GraphDevice {
  id: string;
  deviceName: string | null;
  operatingSystem: string | null;
  osVersion: string | null;
  complianceState:
    | 'compliant'
    | 'noncompliant'
    | 'unknown'
    | 'notApplicable'
    | 'inGracePeriod'
    | 'configManager'
    | null;
  isEncrypted: boolean;
  userId: string | null;
  userPrincipalName: string | null;
  lastSyncDateTime: string | null;
}

interface PageCollection<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

const SELECT =
  'id,deviceName,operatingSystem,osVersion,complianceState,isEncrypted,userId,userPrincipalName,lastSyncDateTime';
export const DEVICE_SYNC_STATE = 'intune-managed-devices';
export const DEVICE_FULL_PASS_STATE = 'intune-managed-devices-full-pass';

/** A device that has not checked in for this long is a risk in itself: it cannot report non-compliance. */
export const STALE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;

/** `compliance_findings` column widths (software_name / software_version). */
const NAME_MAX = 200;
const VERSION_MAX = 60;

export interface DeviceSyncResult {
  devices: number;
  findings: number;
  /** Devices whose evaluation failed; the pass goes on and the cursor does not advance past them. */
  errors: number;
}

/**
 * Intune device compliance sync. Needs DeviceManagementManagedDevices.Read.All.
 *
 * NO UNDOCUMENTED QUERY FEATURE. Every pass lists ALL managed devices, paged, with a plain `$select` —
 * the documented list call. It used to call `/deviceManagement/managedDevices/delta` (not a documented
 * method of the v1.0 managedDevice resource) and then a `$filter=lastSyncDateTime ge …` (also not
 * something the reference promises for this resource). A full list is cheap at this scale and cannot
 * stop working because a query option changed.
 *
 * THE CURSOR SAVES DATABASE WORK, NOT GRAPH CALLS. It is the newest `lastSyncDateTime` seen, stored in
 * `messaging.graph_sync_state` after a pass in which no device failed. A device that has not synced
 * since the cursor cannot have changed state, so its compliance and encryption are not re-evaluated —
 * except in the daily FULL pass, which evaluates every device regardless.
 *
 * STALE DEVICES ARE FINDINGS. A device that stopped checking in cannot report anything, so "no news" is
 * the worst news: every pass flags devices silent for {@link STALE_AFTER_DAYS} days.
 *
 * ONE BAD DEVICE DOES NOT END THE PASS. Each device is evaluated on its own; a failure is counted and
 * logged, the rest are processed, and the cursor stays put so the failed device is tried again.
 */
@Injectable()
export class DeviceSyncService {
  private readonly logger = new Logger(DeviceSyncService.name);

  constructor(
    private readonly graph: GraphClientService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  async syncDevices(now: Date = new Date()): Promise<DeviceSyncResult> {
    if (!this.graph.isEnabled()) return { devices: 0, findings: 0, errors: 0 };

    const client = this.graph.client();
    const cursor = await this.loadState(DEVICE_SYNC_STATE);
    const lastFull = await this.loadState(DEVICE_FULL_PASS_STATE);
    const fullPass = !cursor || !lastFull || now.getTime() - Date.parse(lastFull) >= DAY_MS;

    let url: string | undefined = `/deviceManagement/managedDevices?$top=100&$select=${SELECT}`;
    let totalDevices = 0;
    let totalFindings = 0;
    let errors = 0;
    let newest = cursor;

    while (url) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const page: PageCollection<GraphDevice> = await client.api(url).get();
      for (const device of page.value ?? []) {
        totalDevices += 1;
        const synced = device.lastSyncDateTime ? Date.parse(device.lastSyncDateTime) : NaN;
        if (!Number.isNaN(synced) && (!newest || synced > Date.parse(newest))) {
          newest = device.lastSyncDateTime;
        }
        const changed = fullPass || Number.isNaN(synced) || !cursor || synced >= Date.parse(cursor);
        try {
          totalFindings += await this.evaluate(device, { changed, now });
        } catch (err) {
          errors += 1;
          this.logger.error(
            `Device ${device.id} could not be evaluated: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      url = page['@odata.nextLink'];
    }

    // Only after a pass with no failures: advancing past a device that failed would never retry it.
    if (errors === 0) {
      if (newest && newest !== cursor) await this.saveState(DEVICE_SYNC_STATE, newest);
      if (fullPass) await this.saveState(DEVICE_FULL_PASS_STATE, now.toISOString());
    }

    this.logger.log(
      `Device sync complete: ${totalDevices} devices${fullPass ? ' (full pass)' : ''}, ` +
        `${totalFindings} new findings, ${errors} failed`,
    );
    return { devices: totalDevices, findings: totalFindings, errors };
  }

  private async loadState(name: string): Promise<string | null> {
    const [row] = await this.db
      .select({ cursor: graphSyncState.cursor })
      .from(graphSyncState)
      .where(eq(graphSyncState.name, name))
      .limit(1);
    return row?.cursor ?? null;
  }

  private async saveState(name: string, cursor: string): Promise<void> {
    await this.db
      .insert(graphSyncState)
      .values({ name, cursor })
      .onConflictDoUpdate({ target: graphSyncState.name, set: { cursor, updatedAt: new Date() } });
  }

  /** One device. Returns the number of NEW findings it produced. */
  private async evaluate(
    device: GraphDevice,
    { changed, now }: { changed: boolean; now: Date },
  ): Promise<number> {
    const issues: string[] = [];

    if (changed) {
      if (device.complianceState === 'noncompliant') issues.push('noncompliant');
      if (!device.isEncrypted) issues.push('unencrypted');
    }

    let created = 0;
    if (issues.length > 0) {
      created += await this.raise(
        device,
        `intune:${device.id}:${[...issues].sort().join(',')}`,
        issues.includes('noncompliant') ? 'high' : 'medium',
      );
    }

    const synced = device.lastSyncDateTime ? Date.parse(device.lastSyncDateTime) : NaN;
    if (!Number.isNaN(synced) && now.getTime() - synced > STALE_AFTER_DAYS * DAY_MS) {
      created += await this.raise(device, `intune:${device.id}:stale`, 'medium');
    }
    return created;
  }

  /** Inserts a finding unless a LIVE (not resolved) one with this source key exists. Returns 1 if it inserted. */
  private async raise(
    device: GraphDevice,
    sourceKey: string,
    severity: 'high' | 'medium',
  ): Promise<number> {
    const existing = await this.db
      .select({ id: complianceFindings.id })
      .from(complianceFindings)
      // Against every finding that is still LIVE — open, acknowledged, or a risk someone accepted — but
      // not a RESOLVED one: once it is closed, the same condition returning (a device goes silent
      // again, falls out of compliance again) is a new problem and must be raised again. An accepted
      // risk is a decision, not a closed finding, so it is not re-raised over.
      .where(
        and(eq(complianceFindings.source, sourceKey), ne(complianceFindings.status, 'resolved')),
      )
      .limit(1);
    if (existing.length > 0) return 0;

    await this.db.insert(complianceFindings).values({
      id: newId(),
      softwareName: (device.deviceName ?? `device:${device.id}`).slice(0, NAME_MAX),
      softwareVersion: device.osVersion ? device.osVersion.slice(0, VERSION_MAX) : null,
      severity,
      source: sourceKey,
    });
    return 1;
  }
}

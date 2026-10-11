import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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

/**
 * Intune device compliance sync. Needs DeviceManagementManagedDevices.Read.All.
 *
 * INCREMENTAL WITHOUT A DELTA ENDPOINT. This used to call `/deviceManagement/managedDevices/delta` and
 * keep the returned link in memory. That endpoint is not among the documented methods of the v1.0
 * managedDevice resource (list, get, create, update, delete and the device actions), so it was either
 * never supported or not stable, and an in-memory link restarted from the full device list on every
 * worker restart besides. The documented list endpoint is used instead, filtered on
 * `lastSyncDateTime`: a device whose compliance changed has checked in since the last pass.
 *
 * THE CURSOR IS THE NEWEST `lastSyncDateTime` SEEN, stored in `messaging.graph_sync_state` only after
 * the whole pass finishes, so a crash mid-pass repeats the pass and does not skip devices. Repeating is
 * safe: a finding's `source` key dedupes it.
 */
@Injectable()
export class DeviceSyncService {
  private readonly logger = new Logger(DeviceSyncService.name);

  constructor(
    private readonly graph: GraphClientService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  async syncDevices(): Promise<{ devices: number; findings: number }> {
    if (!this.graph.isEnabled()) return { devices: 0, findings: 0 };

    const client = this.graph.client();
    const cursor = await this.loadCursor();
    const filter = cursor ? `&$filter=${encodeURIComponent(`lastSyncDateTime ge ${cursor}`)}` : '';
    let url: string | undefined =
      `/deviceManagement/managedDevices?$top=100&$select=${SELECT}${filter}`;

    let totalDevices = 0;
    let totalFindings = 0;
    let newest = cursor;

    while (url) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const page: PageCollection<GraphDevice> = await client.api(url).get();
      const devices = page.value ?? [];

      totalDevices += devices.length;
      totalFindings += await this.processDeviceBatch(devices);
      for (const d of devices) {
        if (
          d.lastSyncDateTime &&
          (!newest || Date.parse(d.lastSyncDateTime) > Date.parse(newest))
        ) {
          newest = d.lastSyncDateTime;
        }
      }
      url = page['@odata.nextLink'];
    }

    if (newest && newest !== cursor) await this.saveCursor(newest);

    this.logger.log(
      `Device sync complete: ${totalDevices} devices${cursor ? ` since ${cursor}` : ' (full)'}, ${totalFindings} new findings`,
    );
    return { devices: totalDevices, findings: totalFindings };
  }

  private async loadCursor(): Promise<string | null> {
    const [row] = await this.db
      .select({ cursor: graphSyncState.cursor })
      .from(graphSyncState)
      .where(eq(graphSyncState.name, DEVICE_SYNC_STATE))
      .limit(1);
    return row?.cursor ?? null;
  }

  private async saveCursor(cursor: string): Promise<void> {
    await this.db
      .insert(graphSyncState)
      .values({ name: DEVICE_SYNC_STATE, cursor })
      .onConflictDoUpdate({
        target: graphSyncState.name,
        set: { cursor, updatedAt: new Date() },
      });
  }

  private async processDeviceBatch(devices: GraphDevice[]): Promise<number> {
    let findings = 0;

    for (const device of devices) {
      const issues: string[] = [];

      if (device.complianceState === 'noncompliant') issues.push('noncompliant');
      if (!device.isEncrypted) issues.push('unencrypted');

      if (issues.length === 0) continue;

      // Deduplicate — each device+issue combo gets at most one finding.
      const sourceKey = `intune:${device.id}:${issues.sort().join(',')}`;
      const existing = await this.db
        .select({ id: complianceFindings.id })
        .from(complianceFindings)
        .where(eq(complianceFindings.source, sourceKey))
        .limit(1);

      if (existing.length > 0) continue;

      await this.db.insert(complianceFindings).values({
        id: newId(),
        softwareName: device.deviceName ?? `device:${device.id}`,
        softwareVersion: device.osVersion ?? null,
        severity: issues.includes('noncompliant') ? 'high' : 'medium',
        source: sourceKey,
        detectedAt: new Date(),
      });

      findings++;
    }

    return findings;
  }
}

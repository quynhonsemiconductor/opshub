import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExclusiveJob, InjectDrizzle, type DrizzleDB } from '@platform';
import { graphSyncState } from '../../../../../db/schema';
import { GRAPH_HEARTBEAT_STATE } from '../graph-task';
import { GraphClientService } from '../graph-client.service';
import { GRAPH_LOCK } from '../graph-locks';
import { DeviceSyncService } from './device-sync.service';
import { SecureScoreSyncService } from './secure-score-sync.service';
import { ShadowItScanService } from './shadow-it-scan.service';

/**
 * The scheduled Graph syncs. WORKER ONLY — registered by `GraphModule`, which only the worker imports.
 *
 * With Graph off (no GRAPH_CLIENT_ID) each tick returns at once and says nothing; the one info line
 * comes from `GraphClientService.isEnabled()`. A failure is logged and swallowed so one sync cannot stop
 * the next tick.
 */
@Injectable()
export class GraphSyncCron {
  private readonly logger = new Logger(GraphSyncCron.name);

  constructor(
    private readonly graph: GraphClientService,
    private readonly devices: DeviceSyncService,
    private readonly shadowIt: ShadowItScanService,
    private readonly posture: SecureScoreSyncService,
    private readonly exclusive: ExclusiveJob,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  /**
   * Tells the API whether this worker can run Graph work (see GRAPH_HEARTBEAT_STATE). Every replica
   * writes it — an idempotent upsert, so no lock — and a worker that is down stops writing, which the
   * API reads as "not available".
   */
  @Cron('*/30 * * * * *', { name: 'graph-heartbeat' })
  async heartbeat(): Promise<void> {
    try {
      const cursor = this.graph.isEnabled() ? 'enabled' : 'disabled';
      await this.db
        .insert(graphSyncState)
        .values({ name: GRAPH_HEARTBEAT_STATE, cursor })
        .onConflictDoUpdate({
          target: graphSyncState.name,
          set: { cursor, updatedAt: new Date() },
        });
    } catch (err) {
      this.logger.warn(
        `Graph heartbeat not written: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'compliance-device-sync' })
  async syncDeviceCompliance(): Promise<void> {
    await this.run(GRAPH_LOCK.DEVICE_SYNC.name, GRAPH_LOCK.DEVICE_SYNC.ttlMs, async () => {
      const result = await this.devices.syncDevices();
      this.logger.log(
        `Device compliance sync done — ${result.devices} devices, ${result.findings} new findings`,
      );
    });
  }

  @Cron('0 */6 * * *', { name: 'compliance-shadow-it' })
  async detectShadowIt(): Promise<void> {
    await this.run(GRAPH_LOCK.SHADOW_IT.name, GRAPH_LOCK.SHADOW_IT.ttlMs, async () => {
      await this.shadowIt.detectShadowIt();
    });
  }

  /** Daily at 02:00 UTC — Secure Score data typically refreshes once a day. */
  @Cron('0 2 * * *', { name: 'security-posture-sync' })
  async syncSecurityPosture(): Promise<void> {
    await this.run(GRAPH_LOCK.POSTURE.name, GRAPH_LOCK.POSTURE.ttlMs, async () => {
      await this.posture.runPostureSync();
    });
  }

  private async run(name: string, lockTtlMs: number, work: () => Promise<void>): Promise<void> {
    if (!this.graph.isEnabled()) return;
    await this.exclusive.run(name, lockTtlMs, async () => {
      try {
        await work();
      } catch (err: unknown) {
        this.logger.error(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExclusiveJob } from '@platform';
import { MS_PER_HOUR } from '@shared-kernel';
import { GraphClientService } from '../graph-client.service';
import { DeviceSyncService } from './device-sync.service';
import { SecureScoreSyncService } from './secure-score-sync.service';
import { ShadowItScanService } from './shadow-it-scan.service';

/** Each lock TTL sits just under its schedule, so a crashed pod never blocks the next tick. */
const DEVICE_SYNC_LOCK_TTL_MS = 25 * 60_000;
const SHADOW_IT_LOCK_TTL_MS = 5 * MS_PER_HOUR;
const POSTURE_LOCK_TTL_MS = 23 * MS_PER_HOUR;

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
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'compliance-device-sync' })
  async syncDeviceCompliance(): Promise<void> {
    await this.run('compliance-device-sync', DEVICE_SYNC_LOCK_TTL_MS, async () => {
      const result = await this.devices.syncDevices();
      this.logger.log(
        `Device compliance sync done — ${result.devices} devices, ${result.findings} new findings`,
      );
    });
  }

  @Cron('0 */6 * * *', { name: 'compliance-shadow-it' })
  async detectShadowIt(): Promise<void> {
    await this.run('compliance-shadow-it', SHADOW_IT_LOCK_TTL_MS, async () => {
      await this.shadowIt.detectShadowIt();
    });
  }

  /** Daily at 02:00 UTC — Secure Score data typically refreshes once a day. */
  @Cron('0 2 * * *', { name: 'security-posture-sync' })
  async syncSecurityPosture(): Promise<void> {
    await this.run('security-posture-sync', POSTURE_LOCK_TTL_MS, async () => {
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

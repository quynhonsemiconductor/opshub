import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfigService, CacheService, ExclusiveJob } from '@platform';
import { MS_PER_MIN } from '@shared-kernel';
import { DoorAlertsService } from './door-alerts.service';
import { ITerminalRepository, TERMINAL_REPOSITORY } from '../domain/ports/terminal.repository';

/** Healthchecks.io pings on the check's own cadence; 5 min keeps the two well clear. */
const INTERVAL_MS = 5 * MS_PER_MIN;
/** Under the interval, so a crashed pod cannot block the next check. */
const LOCK_TTL_MS = 4 * MS_PER_MIN;
/**
 * The seen-within window (ADR §4, SA round: 150 min). The terminal syncs every 60 min, so this
 * tolerates one missed sync plus margin before the dead-man's switch goes quiet.
 */
const SEEN_WITHIN_MS = 150 * MS_PER_MIN;

/**
 * Dead-man's-switch for the door terminals (ADR §4): ping Healthchecks.io ONLY while every active
 * terminal was seen within the last 150 minutes. Healthchecks alerts on the ping that never
 * arrives — "the door went quiet" — and on recovery. NO alert state lives in opshub.
 *
 * OFF BY DEFAULT: `DOOR_TERMINAL_HEALTHCHECK_URL` unset means the ping is a no-op. The URL is a
 * secret-ish capability (any holder can forge "all well"), which is why it arrives by env var, not
 * by code. Low-battery alerts are NOT this job's — they fire from the ingestion path on
 * transition (door.service).
 */
@Injectable()
export class DoorTerminalHealthCron {
  private readonly logger = new Logger(DoorTerminalHealthCron.name);

  constructor(
    @Inject(TERMINAL_REPOSITORY) private readonly terminals: ITerminalRepository,
    private readonly config: AppConfigService,
    private readonly exclusive: ExclusiveJob,
    private readonly cache: CacheService,
    private readonly alerts: DoorAlertsService,
    @Optional() private readonly fetchFn: typeof fetch = fetch,
  ) {}

  @Interval(INTERVAL_MS)
  async tick(): Promise<void> {
    await this.exclusive.run('door-terminal-health', LOCK_TTL_MS, async () => {
      const url = this.config.get('DOOR_TERMINAL_HEALTHCHECK_URL');
      if (!url) return; // unset: no check configured, nothing to do

      const active = await this.terminals.countActive();
      const seen = await this.terminals.countActiveSeenSince(new Date(Date.now() - SEEN_WITHIN_MS));
      // Zero active terminals also stays silent: with nothing watching the door, "all well" is a
      // guess, and a dead-man's switch must not sing on a guess.
      const allSeen = active > 0 && active === seen;
      await this.notifyOfflineTransition(active, seen);
      if (!allSeen) {
        // Log loudly but DO NOT ping: the ping's absence is the alert.
        this.logger.warn(
          { active, seen, windowMinutes: SEEN_WITHIN_MS / MS_PER_MIN },
          'door terminal check: an active terminal was not seen recently; healthcheck ping withheld',
        );
        return;
      }
      try {
        const res = await this.fetchFn(url, {
          method: 'GET',
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          this.logger.error({ status: res.status }, 'door terminal healthcheck ping failed');
        }
      } catch (err) {
        this.logger.error({ err }, 'door terminal healthcheck ping failed');
      }
    });
  }

  /**
   * OFFLINE TRANSITION ALERT. Healthchecks.io says "the door went quiet" to whoever watches that
   * check; this says WHICH terminal and WHEN to the people who can fix it (door.manage holders) —
   * on the TRANSITION into stale, not every tick. The state marker lives in the cache under the
   * offline key, so a worker restart mid-alert cannot double-send (a fresh marker is set before
   * the notifications, and the daily idempotency key bounds a resend anyway); the marker is
   * CLEARED when every terminal is seen again, re-arming the alert for the next outage.
   */
  private async notifyOfflineTransition(active: number, seen: number): Promise<void> {
    const key = 'door:terminal:offline-alert';
    const stale = active > 0 && seen < active;
    const marker = await this.cache.getJson<{ stale: boolean }>(key);

    if (stale && marker?.stale !== true) {
      await this.cache.setJson(key, { stale: true }, 7 * 24 * 3600);
      const holders = await this.alerts.doorManageHolders();
      for (const holderId of holders) {
        await this.alerts.send(
          holderId,
          'door.terminal_offline',
          { active, seen, windowMinutes: SEEN_WITHIN_MS / MS_PER_MIN },
          `door.terminal_offline:${new Date().toISOString().slice(0, 10)}`,
        );
      }
      this.logger.warn(
        { active, seen, notified: holders.length },
        'door terminal offline transition: door.manage holders notified',
      );
    } else if (!stale && marker?.stale === true) {
      // Re-arm: everyone is seen again; the next outage alerts anew.
      await this.cache.setJson(key, { stale: false }, 7 * 24 * 3600);
      this.logger.log('door terminals all seen again; offline alert re-armed');
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { GraphClientService } from '../graph-client.service';
import { newId } from '@shared-kernel';
import {
  secureScoreSnapshots,
  baselineChecks,
  baselineCheckCategoryEnum,
  baselineCheckStatusEnum,
} from '../../../../../db/schema';

// ── Graph types ───────────────────────────────────────────────────────────────

interface GraphSecureScore {
  id: string;
  createdDateTime: string;
  currentScore: number;
  maxScore: number;
  enabledServices?: string[];
}

interface GraphSecureScoreControl {
  id: string;
  title: string;
  category: string;
  implementationStatus: 'implemented' | 'notImplemented' | 'planned' | 'ignored' | 'unknown' | null;
  controlScore: number;
  maxScore: number;
}

// ── Service ───────────────────────────────────────────────────────────────────

/** Secure Score pull. Needs SecurityEvents.Read.All. Worker only; the reads live in `SecureScoreQueryService`. */
@Injectable()
export class SecureScoreSyncService {
  private readonly logger = new Logger(SecureScoreSyncService.name);

  constructor(
    private readonly graph: GraphClientService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  /** The whole posture pass: today's score, then the baseline controls. The cron and the task both run this. */
  async runPostureSync(): Promise<{ controls: number } | null> {
    if (!this.graph.isEnabled()) return null;
    const score = await this.syncSecureScore();
    if (score) {
      this.logger.log(
        `Secure Score: ${score.score}/${score.maxScore} (${score.percentage.toFixed(1)}%)`,
      );
    }
    const controls = await this.syncBaselineChecks();
    this.logger.log(`Security posture sync done — ${controls} baseline controls updated`);
    return { controls };
  }

  /**
   * Pull the latest Secure Score from Graph and persist a snapshot.
   * Only inserts if no snapshot exists for today's date yet.
   */
  async syncSecureScore(): Promise<{ score: number; maxScore: number; percentage: number } | null> {
    if (!this.graph.isEnabled()) return null;

    const client = this.graph.client();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res: { value: GraphSecureScore[] } = await client
      .api('/security/secureScores?$top=1')
      .get();

    const latest = res.value?.[0];
    if (!latest) return null;

    const scoreDate = latest.createdDateTime.split('T')[0];
    const percentage = latest.maxScore > 0 ? (latest.currentScore / latest.maxScore) * 100 : 0;

    // Upsert: skip if snapshot for this date already exists
    await this.db
      .insert(secureScoreSnapshots)
      .values({
        id: newId(),
        score: String(latest.currentScore),
        maxScore: String(latest.maxScore),
        percentageScore: String(percentage.toFixed(2)),
        scoreDate,
      })
      .onConflictDoNothing();

    this.logger.log(
      `Secure Score synced: ${latest.currentScore}/${latest.maxScore} (${percentage.toFixed(1)}%)`,
    );
    return { score: latest.currentScore, maxScore: latest.maxScore, percentage };
  }

  /**
   * Sync top improvement actions as baseline checks.
   * Maps Graph control profiles to our `baseline_checks` table.
   */
  async syncBaselineChecks(): Promise<number> {
    if (!this.graph.isEnabled()) return 0;

    const client = this.graph.client();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res: { value: GraphSecureScoreControl[] } = await client
      .api('/security/secureScoreControlProfiles?$top=100')
      .get();

    const controls = res.value ?? [];
    const now = new Date();

    // Delete stale checks from previous sync cycle
    await this.db.delete(baselineChecks);

    const rows = controls.map((c) => {
      const status = this.mapControlStatus(c.implementationStatus);
      const category = this.mapControlCategory(c.category);
      return {
        id: newId(),
        category,
        checkName: c.title,
        status,
        expectedValue: String(c.maxScore),
        actualValue: String(c.controlScore),
        details: c.category,
        checkedAt: now,
      };
    });

    if (rows.length > 0) {
      await this.db.insert(baselineChecks).values(rows);
    }

    this.logger.log(`Baseline checks synced: ${rows.length} controls`);
    return rows.length;
  }

  private mapControlStatus(
    status: string | null,
  ): (typeof baselineCheckStatusEnum.enumValues)[number] {
    switch (status) {
      case 'implemented':
        return 'pass';
      case 'notImplemented':
        return 'fail';
      case 'planned':
        return 'warning';
      case 'ignored':
        return 'warning';
      default:
        return 'not_applicable';
    }
  }

  private mapControlCategory(
    category: string,
  ): (typeof baselineCheckCategoryEnum.enumValues)[number] {
    const lower = category?.toLowerCase() ?? '';
    if (lower.includes('asr') || lower.includes('attack')) return 'asr';
    if (lower.includes('firewall') || lower.includes('network')) return 'firewall';
    if (lower.includes('encrypt')) return 'encryption';
    if (lower.includes('device') || lower.includes('endpoint')) return 'endpoint';
    if (lower.includes('identity') || lower.includes('account')) return 'identity';
    return 'other';
  }
}

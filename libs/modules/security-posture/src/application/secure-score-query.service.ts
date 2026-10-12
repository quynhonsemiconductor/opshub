import { Injectable } from '@nestjs/common';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { desc, sql, gte } from 'drizzle-orm';
import { secureScoreSnapshots, baselineChecks } from '../../../../../db/schema';

/**
 * Reads of the Secure Score snapshots and baseline checks. The API serves these; it never talks to
 * Graph. The rows are written by `SecureScoreSyncService` in the worker (`libs/modules/graph`).
 */
@Injectable()
export class SecureScoreQueryService {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async getScoreHistory(days = 30): Promise<Array<{ scoreDate: string; percentageScore: string }>> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffDate = cutoff.toISOString().split('T')[0];

    return this.db
      .select({
        scoreDate: secureScoreSnapshots.scoreDate,
        percentageScore: secureScoreSnapshots.percentageScore,
      })
      .from(secureScoreSnapshots)
      .where(gte(secureScoreSnapshots.scoreDate, cutoffDate))
      .orderBy(secureScoreSnapshots.scoreDate, secureScoreSnapshots.id)
      .limit(days);
  }

  async getLatestScore(): Promise<{
    score: string;
    maxScore: string;
    percentageScore: string;
    scoreDate: string;
  } | null> {
    const rows = await this.db
      .select()
      .from(secureScoreSnapshots)
      .orderBy(desc(secureScoreSnapshots.scoreDate), secureScoreSnapshots.id)
      .limit(1);
    return rows[0] ?? null;
  }

  async getBaselineChecks(category?: string): Promise<(typeof baselineChecks.$inferSelect)[]> {
    const query = this.db
      .select()
      .from(baselineChecks)
      .orderBy(baselineChecks.category, baselineChecks.checkName, baselineChecks.id);

    if (category) {
      return query.where(sql`${baselineChecks.category} = ${category}`);
    }
    return query;
  }

  async getBaselineSummary(): Promise<
    Record<string, { pass: number; fail: number; warning: number; total: number }>
  > {
    const rows = await this.db
      .select({ category: baselineChecks.category, status: baselineChecks.status })
      .from(baselineChecks);

    const summary: Record<string, { pass: number; fail: number; warning: number; total: number }> =
      {};
    for (const row of rows) {
      if (!summary[row.category]) {
        summary[row.category] = { pass: 0, fail: 0, warning: 0, total: 0 };
      }
      const cat = summary[row.category];
      cat.total++;
      if (row.status === 'pass') cat.pass++;
      else if (row.status === 'fail') cat.fail++;
      else if (row.status === 'warning') cat.warning++;
    }
    return summary;
  }
}

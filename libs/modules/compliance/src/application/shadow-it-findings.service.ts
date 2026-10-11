import { Injectable } from '@nestjs/common';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { complianceFindings } from '../../../../../db/schema';

/**
 * Reads the findings that shadow-IT scans raised. The API serves this; the scan itself (Graph, the
 * Intune detected-apps list) runs in the worker — `ShadowItScanService` in `libs/modules/graph`.
 */
@Injectable()
export class ShadowItFindingsService {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  /**
   * Query findings raised by shadow IT detection (source starts with 'shadow-it:').
   *
   * Deliberately smaller than `REPORT_ROW_LIMIT`: this is the most-recent SAMPLE the detection screen
   * shows to explain what the scan is finding, not the register a reviewer works through. The register is
   * `/v1/compliance/findings`, which pages.
   */
  async listShadowItFindings(limit = 50): Promise<(typeof complianceFindings.$inferSelect)[]> {
    const { like, desc } = await import('drizzle-orm');
    return (
      this.db
        .select()
        .from(complianceFindings)
        .where(like(complianceFindings.source, 'shadow-it:%'))
        /*
         * DESCENDING. This was ascending, which combined with the `limit` returned the OLDEST fifty
         * detections — while the docblock above calls it "the most-recent SAMPLE" and the screen prints
         * "most recent first" underneath the table. So the one thing a detection screen exists for,
         * noticing what has just appeared, was the one thing it could not show; a tenant with more than
         * fifty findings saw a frozen list of its earliest ones.
         *
         * `id` still breaks the tie, so the order stays total and a page cannot lose or repeat a row.
         */
        .orderBy(desc(complianceFindings.detectedAt), desc(complianceFindings.id))
        .limit(limit)
    );
  }
}

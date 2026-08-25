import { Injectable, Logger } from '@nestjs/common';
import { GraphClientService, InjectDrizzle, type DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
import { eq, and } from 'drizzle-orm';
import { complianceFindings, softwareCatalog } from '../../../../../db/schema';

// ── Graph types ───────────────────────────────────────────────────────────────

interface GraphDetectedApp {
  id: string;
  displayName: string | null;
  version: string | null;
  sizeInByte: number | null;
  deviceCount: number | null;
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Shadow IT Detection — cross-references Intune detected apps against the
 * software catalog. Creates compliance findings for blacklisted and un-catalogued
 * applications found on managed devices.
 */
@Injectable()
export class ShadowItDetectionService {
  private readonly logger = new Logger(ShadowItDetectionService.name);

  constructor(
    private readonly graph: GraphClientService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  /**
   * True when Graph is configured. Delegated: the answer is a property of the deployment, not of this
   * service, and five copies of it could disagree.
   */
  isEnabled(): boolean {
    return this.graph.isEnabled();
  }

  /**
   * Fetches the tenant-wide list of detected apps from Intune and creates
   * findings for:
   *   - blacklisted apps (severity: high)
   *   - apps in 'review' status (severity: medium)
   *
   * Returns counts of new findings created.
   */
  async detectShadowIt(): Promise<{ scanned: number; newFindings: number }> {
    if (!this.isEnabled()) return { scanned: 0, newFindings: 0 };

    const client = this.graph.client();
    const catalog = await this.loadCatalog();

    let url: string | undefined =
      '/deviceManagement/detectedApps?$top=100&$select=id,displayName,version,sizeInByte,deviceCount';
    let totalScanned = 0;
    let totalFindings = 0;

    while (url) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const page: { value: GraphDetectedApp[]; '@odata.nextLink'?: string } = await client
        .api(url)
        .get();
      const apps = page.value ?? [];

      totalScanned += apps.length;
      totalFindings += await this.processBatch(apps, catalog);

      url = page['@odata.nextLink'];
    }

    this.logger.log(
      `Shadow IT scan complete: ${totalScanned} apps scanned, ${totalFindings} new findings`,
    );
    return { scanned: totalScanned, newFindings: totalFindings };
  }

  private async loadCatalog(): Promise<Map<string, 'whitelisted' | 'blacklisted' | 'review'>> {
    const rows = await this.db
      .select({ name: softwareCatalog.name, listing: softwareCatalog.listing })
      .from(softwareCatalog);

    const map = new Map<string, 'whitelisted' | 'blacklisted' | 'review'>();
    for (const row of rows) {
      map.set(row.name.toLowerCase(), row.listing);
    }
    return map;
  }

  private async processBatch(
    apps: GraphDetectedApp[],
    catalog: Map<string, 'whitelisted' | 'blacklisted' | 'review'>,
  ): Promise<number> {
    let newFindings = 0;

    for (const app of apps) {
      const name = app.displayName ?? 'Unknown';
      const listing = catalog.get(name.toLowerCase());

      // Skip whitelisted software — no action needed
      if (listing === 'whitelisted') continue;

      const severity = listing === 'blacklisted' ? 'high' : 'medium';
      const sourceKey = `shadow-it:${app.id}`;

      // Deduplicate — skip if an open finding already exists for this app
      const existing = await this.db
        .select({ id: complianceFindings.id })
        .from(complianceFindings)
        .where(and(eq(complianceFindings.source, sourceKey), eq(complianceFindings.status, 'open')))
        .limit(1);

      if (existing.length > 0) continue;

      await this.db.insert(complianceFindings).values({
        id: newId(),
        softwareName: name,
        softwareVersion: app.version ?? null,
        severity,
        source: sourceKey,
        status: 'open',
        detectedAt: new Date(),
      });

      newFindings++;
    }

    return newFindings;
  }

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

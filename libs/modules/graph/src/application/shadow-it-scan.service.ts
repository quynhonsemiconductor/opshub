import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { GraphClientService } from '../graph-client.service';
import { MAX_SCAN_PAGES } from '../graph-task';
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
 * Shadow IT scan — cross-references Intune detected apps against the
 * software catalog. Needs DeviceManagementManagedDevices.Read.All. Runs in the worker only: from the
 * 6-hourly cron, or from a `compliance.shadow_it.scan` task the API enqueued. Creates compliance findings for blacklisted and un-catalogued
 * applications found on managed devices.
 */
@Injectable()
export class ShadowItScanService {
  private readonly logger = new Logger(ShadowItScanService.name);

  constructor(
    private readonly graph: GraphClientService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  /**
   * Fetches the tenant-wide list of detected apps from Intune and creates
   * findings for:
   *   - blacklisted apps (severity: high)
   *   - apps in 'review' status (severity: medium)
   *
   * Returns counts of new findings created.
   */
  async detectShadowIt(): Promise<{ scanned: number; newFindings: number }> {
    if (!this.graph.isEnabled()) return { scanned: 0, newFindings: 0 };

    const client = this.graph.client();
    const catalog = await this.loadCatalog();

    let url: string | undefined =
      '/deviceManagement/detectedApps?$top=100&$select=id,displayName,version,sizeInByte,deviceCount';
    let totalScanned = 0;
    let totalFindings = 0;

    let pages = 0;
    while (url) {
      // The scan's lease is derived from this bound (graph-task.ts): a run that could read for ever
      // could outlive it. 100 pages of 100 apps is far above any real tenant.
      if (pages >= MAX_SCAN_PAGES) {
        this.logger.warn(
          `Shadow IT scan stopped at ${MAX_SCAN_PAGES} pages (${totalScanned} apps): the lease is sized ` +
            `for that many calls. Narrow the query if a tenant really has more.`,
        );
        break;
      }
      pages += 1;
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
}

import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql, isNotNull } from 'drizzle-orm';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB } from '@platform';
import { requestItems } from '../../../../../db/schema/requests';
import { complianceFindings } from '../../../../../db/schema/compliance';
import { assets } from '../../../../../db/schema/assets';
import { leaveRequests, overtimeEntries } from '../../../../../db/schema/workforce';
import type {
  RequestSummaryRow,
  CycleTimeRow,
  SlaComplianceRow,
  QueueDepthRow,
  ThroughputPoint,
  FindingsSummaryRow,
  AssetUtilizationRow,
  LeaveSummaryRow,
  OvertimeSummaryRow,
} from './reports.types';

/**
 * `numeric` arrives from the driver as a STRING, whatever the query claims.
 *
 * `sql<number>` is an assertion about the TypeScript type, not a coercion — and every aggregate in
 * this file that goes through `round(...)::numeric` or `percentile_cont` is one. The assertion then
 * flows into the OpenAPI spec and the generated client, so the SPA is told `number` and handed
 * `"12.00"`.
 *
 * It is not a cosmetic difference. A caller summing the rows — which is exactly what the overtime
 * tile does — CONCATENATES them: two rows of `"12.00"` and `"8.50"` reduce to `"012.008.50"`, and
 * `Math.round` of that is `NaN`. One row happened to work, which is why it survived: overtime has a
 * status enum, so two rows is the ordinary case and the tile rendered the literal string `NaN`.
 *
 * The rest of the codebase already wraps these in `Number(...)` at the point of use. Doing it here
 * instead makes the contract true for every caller, including the generated client.
 */
function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

@Injectable()
export class ReportsService {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ─── Requests ──────────────────────────────────────────────────────────────

  /** Count of requests grouped by type + status within the date range. */
  async getRequestSummary(params: {
    from: Date;
    to: Date;
    type?: string;
  }): Promise<RequestSummaryRow[]> {
    const conditions = [
      gte(requestItems.submittedAt, params.from),
      lte(requestItems.submittedAt, params.to),
      params.type ? eq(requestItems.type, params.type) : undefined,
    ].filter(Boolean) as Parameters<typeof and>;

    const rows = await this.db
      .select({
        type: requestItems.type,
        status: requestItems.status,
        count: sql<number>`count(*)::int`,
      })
      .from(requestItems)
      .where(and(...conditions))
      .groupBy(requestItems.type, requestItems.status)
      .orderBy(requestItems.type, requestItems.status);

    return rows;
  }

  /**
   * Average + P50 + P90 hours from submission to resolution.
   * Only resolved (approved/rejected) requests with a resolvedAt timestamp.
   */
  async getRequestCycleTime(params: {
    from: Date;
    to: Date;
    type?: string;
  }): Promise<CycleTimeRow[]> {
    const conditions = [
      gte(requestItems.submittedAt, params.from),
      lte(requestItems.submittedAt, params.to),
      isNotNull(requestItems.resolvedAt),
      sql`${requestItems.status} IN ('approved', 'rejected')`,
      params.type ? eq(requestItems.type, params.type) : undefined,
    ].filter(Boolean) as Parameters<typeof and>;

    const rows = await this.db
      .select({
        type: requestItems.type,
        total: sql<number>`count(*)::int`,
        avgHours: sql<number>`
          round(
            avg(extract(epoch from (${requestItems.resolvedAt} - ${requestItems.submittedAt})) / 3600)::numeric,
            2
          )`,
        p50Hours: sql<number>`
          round(
            percentile_cont(0.5) within group (
              order by extract(epoch from (${requestItems.resolvedAt} - ${requestItems.submittedAt})) / 3600
            )::numeric,
            2
          )`,
        p90Hours: sql<number>`
          round(
            percentile_cont(0.9) within group (
              order by extract(epoch from (${requestItems.resolvedAt} - ${requestItems.submittedAt})) / 3600
            )::numeric,
            2
          )`,
      })
      .from(requestItems)
      .where(and(...conditions))
      .groupBy(requestItems.type)
      .orderBy(requestItems.type);

    return rows.map((r) => ({
      ...r,
      avgHours: asNumber(r.avgHours),
      p50Hours: asNumber(r.p50Hours),
      p90Hours: asNumber(r.p90Hours),
    }));
  }

  /**
   * SLA compliance rate by request type.
   * Only considers requests that have an SLA set (sla_hours IS NOT NULL).
   */
  async getRequestSlaCompliance(params: {
    from: Date;
    to: Date;
    type?: string;
  }): Promise<SlaComplianceRow[]> {
    const conditions = [
      gte(requestItems.submittedAt, params.from),
      lte(requestItems.submittedAt, params.to),
      isNotNull(requestItems.slaHours),
      params.type ? eq(requestItems.type, params.type) : undefined,
    ].filter(Boolean) as Parameters<typeof and>;

    const rows = await this.db
      .select({
        type: requestItems.type,
        totalWithSla: sql<number>`count(*)::int`,
        resolved: sql<number>`
          count(*) filter (where ${requestItems.status} in ('approved', 'rejected'))::int`,
        withinSla: sql<number>`
          count(*) filter (
            where ${requestItems.status} in ('approved', 'rejected')
              and ${requestItems.slaBreachedAt} is null
          )::int`,
        breached: sql<number>`
          count(*) filter (where ${requestItems.slaBreachedAt} is not null)::int`,
        complianceRatePct: sql<number>`
          round(
            100.0 * count(*) filter (
              where ${requestItems.status} in ('approved', 'rejected')
                and ${requestItems.slaBreachedAt} is null
            ) / nullif(
              count(*) filter (where ${requestItems.status} in ('approved', 'rejected')),
              0
            ),
            1
          )`,
      })
      .from(requestItems)
      .where(and(...conditions))
      .groupBy(requestItems.type)
      .orderBy(requestItems.type);

    return rows;
  }

  /**
   * Current live queue depth — pending + in_review requests grouped by type.
   * Also surfaces "at-risk" items whose SLA deadline is past but not yet marked breached.
   */
  async getRequestQueueDepth(): Promise<QueueDepthRow[]> {
    const rows = await this.db
      .select({
        type: requestItems.type,
        pending: sql<number>`
          count(*) filter (where ${requestItems.status} = 'pending')::int`,
        inReview: sql<number>`
          count(*) filter (where ${requestItems.status} = 'in_review')::int`,
        atRisk: sql<number>`
          count(*) filter (
            where ${requestItems.slaDeadline} < now()
              and ${requestItems.slaBreachedAt} is null
              and ${requestItems.status} in ('pending', 'in_review')
          )::int`,
        total: sql<number>`
          count(*) filter (where ${requestItems.status} in ('pending', 'in_review'))::int`,
      })
      .from(requestItems)
      .where(sql`${requestItems.status} IN ('pending', 'in_review')`)
      .groupBy(requestItems.type)
      .orderBy(requestItems.type);

    return rows;
  }

  /**
   * Daily submission + resolution trend over the given range.
   * Useful for throughput and backlog burn-rate charts.
   */
  async getRequestThroughput(params: {
    from: Date;
    to: Date;
    type?: string;
  }): Promise<ThroughputPoint[]> {
    const conditions = [
      gte(requestItems.submittedAt, params.from),
      lte(requestItems.submittedAt, params.to),
      params.type ? eq(requestItems.type, params.type) : undefined,
    ].filter(Boolean) as Parameters<typeof and>;

    const rows = await this.db
      .select({
        day: sql<string>`date_trunc('day', ${requestItems.submittedAt})::date`,
        submitted: sql<number>`count(*)::int`,
        resolved: sql<number>`
          count(*) filter (where ${requestItems.status} in ('approved', 'rejected', 'cancelled'))::int`,
      })
      .from(requestItems)
      .where(and(...conditions))
      .groupBy(sql`date_trunc('day', ${requestItems.submittedAt})::date`)
      .orderBy(sql`date_trunc('day', ${requestItems.submittedAt})::date`);

    return rows;
  }

  // ─── Compliance ─────────────────────────────────────────────────────────────

  /**
   * Open vs resolved compliance findings grouped by severity.
   */
  async getComplianceFindingsSummary(params: {
    from: Date;
    to: Date;
  }): Promise<FindingsSummaryRow[]> {
    const rows = await this.db
      .select({
        severity: complianceFindings.severity,
        open: sql<number>`
          count(*) filter (where ${complianceFindings.status} = 'open')::int`,
        inRemediation: sql<number>`
          count(*) filter (where ${complianceFindings.status} = 'acknowledged')::int`,
        resolved: sql<number>`
          count(*) filter (where ${complianceFindings.status} = 'resolved')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(complianceFindings)
      .where(
        and(
          gte(complianceFindings.detectedAt, params.from),
          lte(complianceFindings.detectedAt, params.to),
        ),
      )
      .groupBy(complianceFindings.severity)
      .orderBy(complianceFindings.severity);

    return rows;
  }

  // ─── Assets ──────────────────────────────────────────────────────────────────

  /**
   * Asset utilization — counts per type per status (in_stock, assigned, retired, in_repair).
   */
  async getAssetUtilization(): Promise<AssetUtilizationRow[]> {
    const rows = await this.db
      .select({
        type: assets.type,
        inStock: sql<number>`
          count(*) filter (where ${assets.status} = 'in_stock')::int`,
        assigned: sql<number>`
          count(*) filter (where ${assets.status} = 'assigned')::int`,
        retired: sql<number>`
          count(*) filter (where ${assets.status} = 'retired')::int`,
        inRepair: sql<number>`
          count(*) filter (where ${assets.status} = 'in_repair')::int`,
        total: sql<number>`count(*)::int`,
        utilizationPct: sql<number>`
          round(
            100.0 * count(*) filter (where ${assets.status} = 'assigned')
            / nullif(count(*), 0),
            1
          )`,
      })
      .from(assets)
      .groupBy(assets.type)
      .orderBy(assets.type);

    return rows;
  }

  // ─── Workforce ───────────────────────────────────────────────────────────────

  /**
   * Leave requests submitted in the period, grouped by type + status.
   */
  async getLeaveSummary(params: { from: Date; to: Date }): Promise<LeaveSummaryRow[]> {
    const rows = await this.db
      .select({
        leaveType: leaveRequests.leaveType,
        status: leaveRequests.status,
        count: sql<number>`count(*)::int`,
      })
      .from(leaveRequests)
      .where(
        and(gte(leaveRequests.createdAt, params.from), lte(leaveRequests.createdAt, params.to)),
      )
      .groupBy(leaveRequests.leaveType, leaveRequests.status)
      .orderBy(leaveRequests.leaveType, leaveRequests.status);

    return rows;
  }

  /**
   * Overtime entries submitted in the period grouped by status, with total hours.
   */
  async getOvertimeSummary(params: { from: Date; to: Date }): Promise<OvertimeSummaryRow[]> {
    const rows = await this.db
      .select({
        status: overtimeEntries.status,
        count: sql<number>`count(*)::int`,
        totalHours: sql<number>`round(sum(${overtimeEntries.hours})::numeric, 2)`,
        avgHours: sql<number>`round(avg(${overtimeEntries.hours})::numeric, 2)`,
      })
      .from(overtimeEntries)
      .where(
        and(gte(overtimeEntries.createdAt, params.from), lte(overtimeEntries.createdAt, params.to)),
      )
      .groupBy(overtimeEntries.status)
      .orderBy(overtimeEntries.status);

    return rows.map((r) => ({
      ...r,
      totalHours: asNumber(r.totalHours),
      avgHours: asNumber(r.avgHours),
    }));
  }
}

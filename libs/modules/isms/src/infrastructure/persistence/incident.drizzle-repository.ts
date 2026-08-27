import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
// `assets` and `risks` are read here for one reason only: the reference guards below, which restate
// `incidents`' own foreign keys as an answer a client can act on.
import { assets, incidentEvents, incidents, risks } from '../../../../../../db/schema';
import type { IIncidentRepository } from '../../domain/ports/incident.repository';
import type {
  Incident,
  IncidentEvent,
  IncidentFilters,
  OverdueBreach,
  RecordEventInput,
  ReportIncidentInput,
  UpdateIncidentInput,
} from '../../domain/incident.types';

/** Terminal states. Everything else is still being handled. */
const CLOSED_STATUSES = ['closed', 'false_positive'] as const;

/**
 * Severity worst-first, as SQL.
 *
 * The enum's declaration order is low → critical, so a plain `DESC` on the column already yields
 * critical first — but relying on the declaration order silently changes meaning if anybody ever
 * inserts a value into the middle of the enum. Ordering by an explicit CASE says what it means.
 */
const SEVERITY_RANK = sql`CASE ${incidents.severity}
  WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`;

@Injectable()
export class IncidentDrizzleRepository implements IIncidentRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async create(
    input: ReportIncidentInput & { reportedBy: string },
    tx?: DbExecutor,
  ): Promise<Incident> {
    const [row] = await (tx ?? this.db)
      .insert(incidents)
      .values({
        id: newId(),
        reference: input.reference,
        title: input.title,
        description: input.description,
        category: input.category,
        severity: input.severity,
        detectedAt: new Date(input.detectedAt),
        reportedBy: input.reportedBy,
        assetId: input.assetId ?? null,
        riskId: input.riskId ?? null,
        personalDataBreach: input.personalDataBreach ?? false,
      })
      .returning();
    return row;
  }

  async findById(id: string, tx?: DbExecutor): Promise<Incident | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(incidents)
      .where(eq(incidents.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByReference(reference: string): Promise<Incident | null> {
    const [row] = await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.reference, reference))
      .limit(1);
    return row ?? null;
  }

  async list(
    filters: IncidentFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: Incident[]; total: number }> {
    const where = and(
      filters.status ? eq(incidents.status, filters.status) : undefined,
      filters.severity ? eq(incidents.severity, filters.severity) : undefined,
      filters.category ? eq(incidents.category, filters.category) : undefined,
      filters.assignedTo ? eq(incidents.assignedTo, filters.assignedTo) : undefined,
      filters.riskId ? eq(incidents.riskId, filters.riskId) : undefined,
      filters.openOnly ? notInArray(incidents.status, [...CLOSED_STATUSES]) : undefined,
      filters.breachesOnly ? eq(incidents.personalDataBreach, true) : undefined,
    );

    const rows = await this.db
      .select()
      .from(incidents)
      .where(where)
      // Worst first, then oldest detection: during a response the question is always "what is the
      // most serious thing that has been running longest". `id` last, because neither severity nor a
      // detection timestamp is unique.
      .orderBy(desc(SEVERITY_RANK), asc(incidents.detectedAt), asc(incidents.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(incidents)
      .where(where);

    return { rows, total: count };
  }

  async update(id: string, input: UpdateIncidentInput, tx?: DbExecutor): Promise<Incident | null> {
    const { detectedAt, ...rest } = input;
    const [row] = await (tx ?? this.db)
      .update(incidents)
      .set({
        ...rest,
        ...(detectedAt === undefined ? {} : { detectedAt: new Date(detectedAt) }),
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, id))
      .returning();
    return row ?? null;
  }

  async transition(
    id: string,
    from: Incident['status'],
    to: Incident['status'],
    extra: Partial<
      Pick<
        Incident,
        | 'assignedTo'
        | 'containedAt'
        | 'resolvedAt'
        | 'closedAt'
        | 'rootCause'
        | 'lessonsLearned'
        | 'regulatorNotifiedAt'
      >
    >,
    tx?: DbExecutor,
  ): Promise<Incident | null> {
    const [row] = await (tx ?? this.db)
      .update(incidents)
      .set({ status: to, ...extra, updatedAt: new Date() })
      // The FROM state is in the WHERE clause. Two responders working the same incident is the
      // normal case, not the edge case, so the race has to be Postgres's decision.
      .where(and(eq(incidents.id, id), eq(incidents.status, from)))
      .returning();
    return row ?? null;
  }

  async markRegulatorNotified(
    id: string,
    notifiedAt: Date,
    tx?: DbExecutor,
  ): Promise<Incident | null> {
    const [row] = await (tx ?? this.db)
      .update(incidents)
      .set({ regulatorNotifiedAt: notifiedAt, updatedAt: new Date() })
      // Un-notified only: stamping twice would overwrite when the regulator was actually told,
      // which is the one date the notification obligation turns on.
      .where(
        and(
          eq(incidents.id, id),
          eq(incidents.personalDataBreach, true),
          isNull(incidents.regulatorNotifiedAt),
        ),
      )
      .returning();
    return row ?? null;
  }

  // ── Reference guards ─────────────────────────────────────────────────────────

  /**
   * Whether the referenced rows exist, so the service can name the offending FIELD.
   *
   * Both select the primary key only. The question is existence, and a `SELECT *` here would carry a
   * whole risk or asset row across the wire for a `!== undefined`.
   */
  async riskExists(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: risks.id })
      .from(risks)
      .where(eq(risks.id, id))
      .limit(1);
    return row !== undefined;
  }

  async assetExists(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, id))
      .limit(1);
    return row !== undefined;
  }

  // ── Timeline ─────────────────────────────────────────────────────────────────

  async appendEvent(
    incidentId: string,
    /**
     * `occurredAt` is OMITTED from the input type and re-added as a `Date`: the DTO carries it as an
     * ISO string, and intersecting the two gives `string & Date`, which nothing satisfies.
     */
    input: Omit<RecordEventInput, 'occurredAt'> & { recordedBy: string; occurredAt: Date },
    tx?: DbExecutor,
  ): Promise<IncidentEvent> {
    const [row] = await (tx ?? this.db)
      .insert(incidentEvents)
      .values({
        id: newId(),
        incidentId,
        type: input.type,
        detail: input.detail,
        recordedBy: input.recordedBy,
        occurredAt: input.occurredAt,
      })
      .returning();
    return row;
  }

  async listEvents(incidentId: string): Promise<IncidentEvent[]> {
    return (
      this.db
        .select()
        .from(incidentEvents)
        .where(eq(incidentEvents.incidentId, incidentId))
        // Chronological by when things HAPPENED, `id` last: several entries share a minute during an
        // incident, so without the tiebreaker paging a long timeline drops and repeats rows.
        .orderBy(asc(incidentEvents.occurredAt), asc(incidentEvents.id))
    );
  }

  // ── Reports ──────────────────────────────────────────────────────────────────

  async overdueBreaches(limit: number): Promise<OverdueBreach[]> {
    const due = sql<Date>`${incidents.detectedAt} + interval '72 hours'`;

    return (
      this.db
        .select({
          id: incidents.id,
          reference: incidents.reference,
          title: incidents.title,
          severity: incidents.severity,
          detectedAt: incidents.detectedAt,
          notificationDueAt: due,
          // Computed alongside the row so nothing downstream recalculates it.
          hoursOverdue: sql<number>`
          floor(extract(epoch from (now() - (${incidents.detectedAt} + interval '72 hours'))) / 3600)::int
        `,
        })
        .from(incidents)
        .where(
          and(
            eq(incidents.personalDataBreach, true),
            isNull(incidents.regulatorNotifiedAt),
            // The deadline lives in this one query: it cannot be a generated column, because
            // `timestamptz + interval` is only STABLE and Postgres requires IMMUTABLE.
            sql`${incidents.detectedAt} + interval '72 hours' <= now()`,
          ),
        )
        // Most overdue first — the only order that matters when a regulator deadline has passed.
        .orderBy(asc(incidents.detectedAt), asc(incidents.id))
        .limit(limit)
    );
  }

  async unlinkedToRisk(limit: number): Promise<Incident[]> {
    return this.db
      .select()
      .from(incidents)
      .where(
        and(
          isNull(incidents.riskId),
          // A closed incident nobody linked is history; the gap worth acting on is an open one.
          notInArray(incidents.status, [...CLOSED_STATUSES]),
        ),
      )
      .orderBy(desc(SEVERITY_RANK), asc(incidents.detectedAt), asc(incidents.id))
      .limit(limit);
  }
}

/**
 * Whether an incident has finished being handled.
 *
 * Exported from here rather than duplicated in the service, so the repository's "open" filter and
 * the service's "cannot change a closed incident" guard cannot disagree about what closed means.
 */
export const isTerminalIncidentStatus = (status: Incident['status']): boolean =>
  (CLOSED_STATUSES as readonly string[]).includes(status);

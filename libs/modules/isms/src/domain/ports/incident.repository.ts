import type { DbExecutor } from '@platform';
import type {
  Incident,
  IncidentEvent,
  IncidentFilters,
  OverdueBreach,
  RecordEventInput,
  ReportIncidentInput,
  UpdateIncidentInput,
} from '../incident.types';

export const INCIDENT_REPOSITORY = Symbol('INCIDENT_REPOSITORY');

export interface IIncidentRepository {
  create(input: ReportIncidentInput & { reportedBy: string }, tx?: DbExecutor): Promise<Incident>;
  findById(id: string, tx?: DbExecutor): Promise<Incident | null>;
  findByReference(reference: string): Promise<Incident | null>;
  list(
    filters: IncidentFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: Incident[]; total: number }>;
  update(id: string, input: UpdateIncidentInput, tx?: DbExecutor): Promise<Incident | null>;
  /**
   * Move an incident's status, guarding the FROM state in the WHERE clause.
   *
   * Returns null when the row was not in `from` — which is what makes the transition atomic rather
   * than a read-then-write two responders can both pass during an incident, which is exactly when
   * two people are working the same ticket.
   */
  transition(
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
  ): Promise<Incident | null>;
  /** Record the regulator notification. Guarded so it cannot be stamped twice. */
  markRegulatorNotified(id: string, notifiedAt: Date, tx?: DbExecutor): Promise<Incident | null>;

  // ── Reference guards ───────────────────────────────────────────────────────
  /*
   * `risk_id` and `asset_id` DO carry foreign keys — unlike the cross-schema employee references,
   * which deliberately carry none — so these two do not exist to keep the data consistent. Postgres
   * already does that. They exist so the service can REFUSE a dangling reference with a code and a
   * field name, because the FK arrives as SQLSTATE 23503 and reaches the caller as a 500 with no
   * indication of which field was wrong.
   *
   * Existence rather than the row: nothing reads a risk or an asset here, and fetching one to throw
   * it away is the shape `EmployeeService.assertExist` was written to retire.
   */
  riskExists(id: string): Promise<boolean>;
  assetExists(id: string): Promise<boolean>;

  // ── Timeline ───────────────────────────────────────────────────────────────
  /**
   * Append one timeline entry. There is deliberately no update and no delete.
   *
   * A post-incident review is read by people judging whether the handling was adequate, so a
   * timeline that can be edited afterwards is not evidence. Corrections are new rows.
   */
  appendEvent(
    incidentId: string,
    /**
     * `occurredAt` is OMITTED from the input type and re-added as a `Date`: the DTO carries it as an
     * ISO string, and intersecting the two gives `string & Date`, which nothing satisfies.
     */
    input: Omit<RecordEventInput, 'occurredAt'> & { recordedBy: string; occurredAt: Date },
    tx?: DbExecutor,
  ): Promise<IncidentEvent>;
  listEvents(incidentId: string): Promise<IncidentEvent[]>;

  // ── Reports ────────────────────────────────────────────────────────────────
  /**
   * Personal-data breaches past their 72-hour deadline with no notification recorded.
   *
   * The deadline is derived here — `detected_at + interval '72 hours'` — because it cannot be a
   * generated column: `timestamptz + interval` is only STABLE, and Postgres requires IMMUTABLE.
   * Keeping it in this one query is what stops the arithmetic being repeated.
   */
  overdueBreaches(limit: number): Promise<OverdueBreach[]>;
  /**
   * Open incidents with no linked risk.
   *
   * The feedback loop the register needs: an incident nobody foresaw is a gap in the risk
   * assessment, and this is how it surfaces rather than by forcing a link at report time.
   */
  unlinkedToRisk(limit: number): Promise<Incident[]>;
}

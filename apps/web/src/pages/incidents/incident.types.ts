import type { components } from '@/shared/api/generated/api';

/**
 * The incident vocabulary, from the generated spec.
 */

export type Incident = components['schemas']['IncidentResponseDto'];
export type IncidentEvent = components['schemas']['IncidentEventResponseDto'];
export type OverdueBreach = components['schemas']['OverdueBreachResponseDto'];

/**
 * The lifecycle, in order, with `false_positive` off to one side.
 *
 * reported → triaged → contained → resolved → closed. The API holds the same map
 * (`ALLOWED_TRANSITIONS`) and every move is additionally a guarded `WHERE status = <from>`, so two
 * responders working one incident race in Postgres rather than in a service. This list exists for
 * FILTERING and for labels; the screen never decides whether a move is legal.
 */
export const INCIDENT_STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'reported', label: 'Reported' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'contained', label: 'Contained' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
  { value: 'false_positive', label: 'False positive' },
] as const;

/**
 * Which action a status allows, mirrored from the API's own transition map.
 *
 * Used ONLY to decide which button to draw. `false_positive` is reachable early and from nowhere late:
 * once something has been contained it demonstrably was an incident, so dismissing it afterwards would
 * contradict the containment timestamp — and `ck_incident_false_positive` refuses that too.
 */
export const NEXT_ACTIONS: Record<
  string,
  readonly ('triage' | 'contain' | 'resolve' | 'close' | 'dismiss')[]
> = {
  reported: ['triage', 'dismiss'],
  triaged: ['contain', 'dismiss'],
  contained: ['resolve'],
  resolved: ['close'],
  closed: [],
  false_positive: [],
};

/**
 * The statuses that accept no further correction, mirrored from the repository's `CLOSED_STATUSES`.
 *
 * `PATCH /v1/incidents/:id` runs `assertOpen` first, so both of these answer `INCIDENT_NOT_IN_STATE`
 * with "add a timeline entry instead". The screen uses this to decide whether to DRAW the Correct
 * action and never to decide whether a correction is legal — an action whose only outcome is a
 * refusal is worse than no action, because the user learns the rule from an error instead of from
 * the absence of a button.
 *
 * `false_positive` belongs here alongside `closed` for the same reason the API puts it there: it is a
 * finished record, not a state somebody is still working in.
 */
export const TERMINAL_INCIDENT_STATUSES = ['closed', 'false_positive'] as const;

/** Named after the API's own exported helper, so the two cannot drift on what "finished" means. */
export const isTerminalIncidentStatus = (status: string): boolean =>
  (TERMINAL_INCIDENT_STATUSES as readonly string[]).includes(status);

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/** What a timeline entry can be. `status_change` is written by the API, never by a person. */
export const EVENT_TYPES = ['note', 'evidence', 'notification'] as const;

/**
 * GDPR Article 33: 72 hours from becoming aware.
 *
 * The API computes `notificationDueAt` from `detectedAt` when the incident is a personal-data breach;
 * this constant exists so the UI can SAY the rule rather than restate the arithmetic. Nothing here
 * calculates a deadline.
 */
export const BREACH_NOTIFICATION_HOURS = 72;

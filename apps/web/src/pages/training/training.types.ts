import type { components } from '@/shared/api/generated/api';

/**
 * The training vocabulary, from the generated spec.
 *
 * Nothing here is re-typed by hand. Every screen in this migration that hand-wrote a response type
 * eventually drifted from the API — a field renamed, a nullable one typed as required — and the drift
 * only showed up as a blank cell.
 */

export type Course = components['schemas']['CourseResponseDto'];
export type TrainingRecord = components['schemas']['TrainingRecordResponseDto'];
export type Requirement = components['schemas']['RequirementResponseDto'];
export type CompetencyGap = components['schemas']['CompetencyGapResponseDto'];
export type Certificate = components['schemas']['CertificateResponseDto'];

/**
 * A record's status, as the API filters on it.
 *
 * `valid` / `expired` / `revoked` are the only three the query accepts — `expired` is DERIVED from
 * `expiresOn` rather than stored, so a record does not need a nightly job to become expired and the UI
 * must not compute its own version of that comparison.
 */
export const RECORD_STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'valid', label: 'Valid' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
] as const;

/**
 * Mandatory or recommended, per role.
 *
 * The distinction is what makes a gap report actionable: a missing MANDATORY course is a compliance
 * finding, a missing recommended one is a suggestion, and the gap endpoint leaves the recommended ones
 * out unless asked. Conflating them would turn every report into noise.
 */
export const REQUIREMENT_KINDS = ['mandatory', 'recommended'] as const;

/**
 * What a certificate upload may be.
 *
 * Mirrors the API's `mimeType` enum exactly. A file the picker accepts and the API refuses is a wasted
 * upload and an error the user cannot act on, so this list is not a superset for convenience.
 */
export const CERTIFICATE_ACCEPT =
  'application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The horizon the "expiring soon" filter uses — the same 90 days the contracts renewal queue uses. */
export const EXPIRY_HORIZON_DAYS = 90;

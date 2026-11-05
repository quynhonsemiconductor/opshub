import type {
  trainingCourses,
  trainingRoleRequirements,
  trainingRecords,
} from '../../../../../db/schema';

export type TrainingCourse = typeof trainingCourses.$inferSelect;
export type TrainingRequirement = typeof trainingRoleRequirements.$inferSelect;
export type TrainingRecord = typeof trainingRecords.$inferSelect;
export type RequirementKind = TrainingRequirement['kind'];
export type RecordStatus = TrainingRecord['status'];

export interface CreateCourseInput {
  code: string;
  title: string;
  category: string;
  provider?: string | null;
  description?: string | null;
  validityMonths?: number | null;
}

export type UpdateCourseInput = Partial<Omit<CreateCourseInput, 'code'>>;

export interface CourseFilters {
  category?: string;
  /** Retired courses are hidden by default: they cannot be required or recorded against. */
  includeRetired?: boolean;
}

export interface RecordCompletionInput {
  employeeId: string;
  courseId: string;
  completedOn: string;
  result?: string | null;
  score?: string | null;
  notes?: string | null;
}

export interface RecordFilters {
  employeeId?: string;
  courseId?: string;
  status?: RecordStatus;
  /** Live records whose `expires_on` falls on or before this date — the renewal queue. */
  expiringOnOrBefore?: string;
  /** Excludes superseded rows, which is what "their current training" means. */
  currentOnly?: boolean;
}

/**
 * One line of the competency gap report.
 *
 * `recordId` null means the course has never been completed; a non-null `expiresOn` in the past
 * means it lapsed. Both are gaps, and the report distinguishes them because the remedy differs:
 * one is scheduling, the other is rescheduling.
 */
export interface CompetencyGap {
  employeeId: string;
  roleId: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  kind: RequirementKind;
  graceDays: number | null;
  recordId: string | null;
  completedOn: string | null;
  expiresOn: string | null;
  reason: 'never_completed' | 'expired';
}

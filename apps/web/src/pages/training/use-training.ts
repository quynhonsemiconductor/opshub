import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { isoDaysFromNow } from '@/shared/lib/format';
import { EXPIRY_HORIZON_DAYS } from './training.types';
import type {
  Certificate,
  CompetencyGap,
  Course,
  Requirement,
  TrainingRecord,
} from './training.types';

/**
 * Every read the training screens make, in one module.
 *
 * All keys start `['training', …]`, so one `invalidateQueries({ queryKey: ['training'] })` after a
 * mutation refreshes whichever tabs are mounted. Five tabs each inventing their own key prefix is how a
 * verify on the records tab leaves the gaps report showing the gap it just closed.
 */

export function useCourses(
  category: string,
  includeRetired: boolean,
  limit: number,
  offset: number,
) {
  return useQuery({
    queryKey: ['training', 'courses', category, includeRetired, limit, offset],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/training/courses', {
        params: { query: { category: category || undefined, includeRetired, limit, offset } },
      });
      if (error || !data) throw new Error('Failed to load courses');
      return data;
    },
  });
}

export function useRecords(params: {
  employeeId: string;
  courseId: string;
  status: string;
  expiringSoon: boolean;
  currentOnly: boolean;
  limit: number;
  offset: number;
}) {
  const { employeeId, courseId, status, expiringSoon, currentOnly, limit, offset } = params;
  return useQuery({
    queryKey: [
      'training',
      'records',
      employeeId,
      courseId,
      status,
      expiringSoon,
      currentOnly,
      limit,
      offset,
    ],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/training/records', {
        params: {
          query: {
            employeeId: employeeId || undefined,
            courseId: courseId || undefined,
            status: (status || undefined) as never,
            // A DATE the API compares against `expires_on`, not a boolean it has to interpret. The
            // horizon is ours; the comparison is the API's.
            expiringOnOrBefore: expiringSoon ? isoDaysFromNow(EXPIRY_HORIZON_DAYS) : undefined,
            currentOnly: currentOnly || undefined,
            limit,
            offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load training records');
      return data;
    },
  });
}

/**
 * A role's required courses.
 *
 * `enabled` on a chosen role rather than fetching for `undefined`: a request with no role is a
 * 400 the user did not ask for, and an empty table would read as "this role requires nothing".
 */
export function useRequirements(roleId: string | null) {
  return useQuery<Requirement[]>({
    queryKey: ['training', 'requirements', roleId],
    enabled: !!roleId,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/training/roles/{roleId}/requirements', {
        params: { path: { roleId: roleId! } },
      });
      if (error || !data) throw new Error('Failed to load requirements');
      return data;
    },
  });
}

/**
 * The competency gap report.
 *
 * Needs at least one of employee or role — the API refuses an unbounded sweep, which is the right
 * call for a report that joins every requirement against every record.
 */
export function useGaps(params: {
  employeeId: string;
  roleId: string;
  includeRecommended: boolean;
}) {
  const { employeeId, roleId, includeRecommended } = params;
  return useQuery<CompetencyGap[]>({
    queryKey: ['training', 'gaps', employeeId, roleId, includeRecommended],
    enabled: !!(employeeId || roleId),
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/training/gaps', {
        params: {
          query: {
            employeeId: employeeId || undefined,
            roleId: roleId || undefined,
            includeRecommended,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load competency gaps');
      return data;
    },
  });
}

/** The caller's own records and gaps — self-scoped, so no permission code is involved. */
export function useMyTraining() {
  return useQuery<TrainingRecord[]>({
    queryKey: ['training', 'me', 'records'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/training/me');
      if (error || !data) throw new Error('Failed to load your training');
      return data;
    },
  });
}

export function useMyGaps() {
  return useQuery<CompetencyGap[]>({
    queryKey: ['training', 'me', 'gaps'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/training/me/gaps');
      if (error || !data) throw new Error('Failed to load your competency gaps');
      return data;
    },
  });
}

export function useCertificates(recordId: string | null) {
  return useQuery<Certificate[]>({
    queryKey: ['training', 'certificates', recordId],
    enabled: !!recordId,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/training/records/{id}/certificates', {
        params: { path: { id: recordId! } },
      });
      if (error || !data) throw new Error('Failed to load certificates');
      return data;
    },
  });
}

/**
 * The course vocabulary, for labelling a record's `courseId`.
 *
 * A record carries ids, not names, and every table that shows one needs the title. Fetched ONCE per
 * screen as a map rather than per row: a lookup per row is the N+1 that makes a 25-row page issue 25
 * requests, and the course list is small enough to hold whole.
 */
export function useCourseLookup() {
  return useQuery({
    queryKey: ['training', 'course-lookup'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/training/courses', {
        params: { query: { includeRetired: true, limit: 100, offset: 0 } },
      });
      if (error || !data) throw new Error('Failed to load courses');
      const byId = new Map<string, Course>();
      for (const course of data.data ?? []) byId.set(course.id, course);
      return byId;
    },
  });
}

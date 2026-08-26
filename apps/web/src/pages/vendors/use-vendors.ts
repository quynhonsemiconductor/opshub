import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { STALE } from '@/shared/api/cache';
import type {
  CriticalityLevel,
  LinkedRisk,
  ReviewGap,
  UnassessedSpend,
  Vendor,
  VendorAssessment,
} from './vendor.types';

/**
 * Every read the supplier register makes.
 *
 * Keys start `['vendors', …]`. Recording an assessment moves the review-gap report and the row's own
 * last-assessed date, so one invalidation refreshes both rather than leaving a gap report that still
 * lists the supplier somebody just assessed.
 */

export function useVendors(params: {
  status: string;
  criticality: string;
  processorsOnly: boolean;
  search: string;
  limit: number;
  offset: number;
}) {
  const { status, criticality, processorsOnly, search, limit, offset } = params;
  return useQuery({
    queryKey: ['vendors', 'list', status, criticality, processorsOnly, search, limit, offset],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/vendors', {
        params: {
          query: {
            status: (status || undefined) as never,
            criticality: (criticality || undefined) as never,
            processorsOnly: processorsOnly || undefined,
            search: search || undefined,
            limit,
            offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load the supplier register');
      return data;
    },
  });
}

/**
 * The criticality levels, as reference data.
 *
 * Each carries its REVIEW INTERVAL and whether independent evidence is required — the two facts that
 * decide how often a supplier must be assessed and what counts as an assessment. Read from the API so a
 * policy change lands in one place.
 */
export function useCriticalityLevels() {
  return useQuery<CriticalityLevel[]>({
    queryKey: ['vendors', 'criticality-levels'],
    staleTime: STALE.REFERENCE,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/vendors/criticality-levels');
      if (error || !data) throw new Error('Failed to load criticality levels');
      return data;
    },
  });
}

/**
 * The TITLE of a controlled document the register points at — today only the data-processing agreement.
 *
 * WHY THE REGISTER READS THE DOCUMENTS ENDPOINT AT ALL. `dataProcessingAgreementId` is a uuid on the
 * vendor row and nothing else, so a correction form pre-filled from that row can only show the picker
 * thirty-six characters identifying nothing — which is the exact defect `EntityPicker.selectedLabel`
 * exists to prevent. One request, only when a supplier already HAS an agreement recorded.
 *
 * A failure is not an error here: `document.read` is a separate code from `vendor.manage`, so a
 * `null` title falls back to the id rather than breaking the form. `retry: false` because a 403 will
 * not become a 200.
 */
export function useDocumentTitle(documentId: string | null | undefined) {
  return useQuery<string | null>({
    queryKey: ['vendors', 'document-title', documentId],
    enabled: !!documentId,
    staleTime: STALE.REFERENCE,
    retry: false,
    queryFn: async () => {
      const { data } = await api.GET('/v1/documents/{id}', {
        params: { path: { id: documentId! } },
      });
      return data ? `${data.code} — ${data.title}` : null;
    },
  });
}

export function useVendorAssessments(vendorId: string | null) {
  return useQuery<VendorAssessment[]>({
    queryKey: ['vendors', 'assessments', vendorId],
    enabled: !!vendorId,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/vendors/{id}/assessments', {
        params: { path: { id: vendorId! } },
      });
      if (error || !data) throw new Error('Failed to load the assessments');
      return data;
    },
  });
}

/** The risks a supplier introduces — the link that makes third-party risk answerable from either side. */
export function useVendorRisks(vendorId: string | null) {
  return useQuery<LinkedRisk[]>({
    queryKey: ['vendors', 'risks', vendorId],
    enabled: !!vendorId,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/vendors/{id}/risks', {
        params: { path: { id: vendorId! } },
      });
      if (error || !data) throw new Error('Failed to load the linked risks');
      return data;
    },
  });
}

/**
 * Suppliers overdue an assessment, with how many days.
 *
 * The interval comes from the criticality level, so the API computes both the due date and the overdue
 * count — a critical supplier assessed annually and a low-risk one assessed every three years are the same
 * report with different arithmetic, and doing it here would be doing it twice.
 */
export function useReviewGaps() {
  return useQuery<ReviewGap[]>({
    queryKey: ['vendors', 'review-gaps'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/vendors/reports/review-gaps');
      if (error || !data) throw new Error('Failed to load the review gaps');
      return data;
    },
  });
}

/**
 * Critical suppliers with no risk on the register.
 *
 * A supplier that could stop the business, and nothing in the risk register says so. Same shape of
 * question as the SoA's untreated risks, from the other direction.
 */
export function useCriticalWithoutRisk() {
  return useQuery<Vendor[]>({
    queryKey: ['vendors', 'critical-without-risk'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/vendors/reports/critical-without-risk');
      if (error || !data) throw new Error('Failed to load critical suppliers without a risk');
      return data as Vendor[];
    },
  });
}

/**
 * Money going to suppliers nobody has assessed.
 *
 * Joins software licences to the register by the vendor TEXT on the licence, so it also surfaces licences
 * whose supplier was never linked at all (`vendorId: null`) — which is the more common gap and the one a
 * finance-led review finds first.
 */
export function useUnassessedSpend() {
  return useQuery<UnassessedSpend[]>({
    queryKey: ['vendors', 'unassessed-spend'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/vendors/reports/unassessed-spend');
      if (error || !data) throw new Error('Failed to load unassessed spend');
      return data;
    },
  });
}

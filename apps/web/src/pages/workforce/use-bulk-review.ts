import { useState } from 'react';
import { toast } from 'sonner';
import { apiErrorMessage } from '@/shared/api/errors';

/**
 * The one shape shared by timesheets/leave/overtime bulk review: N single-row calls, not a bulk
 * endpoint — there is none for any of the three. Only rows this viewer could decide one at a time
 * are attempted (via `verdict`), and only the ids that succeeded leave the selection, so a failure
 * survives as the thing still ticked.
 */
export function useBulkReview<T extends { id: string }>({
  rows,
  selectedIds,
  setSelectedIds,
  verdict,
  review,
  invalidate,
  entityLabel,
}: {
  rows: readonly T[] | undefined;
  selectedIds: string[];
  setSelectedIds: (fn: (ids: string[]) => string[]) => void;
  verdict: (row: T) => 'offer' | unknown;
  review: (id: string, approve: boolean) => Promise<unknown>;
  invalidate: () => void;
  entityLabel: string;
}) {
  const [reviewing, setReviewing] = useState(false);

  async function handleBulkReview(approve: boolean) {
    const reviewable = (rows ?? []).filter(
      (row) => selectedIds.includes(row.id) && verdict(row) === 'offer',
    );
    if (reviewable.length === 0 || reviewing) return;
    setReviewing(true);
    let failed = 0;
    let firstError: unknown = null;
    const succeeded: string[] = [];
    for (const row of reviewable) {
      const error = await review(row.id, approve);
      if (error) {
        failed += 1;
        firstError = firstError ?? error;
      } else {
        succeeded.push(row.id);
      }
    }
    setReviewing(false);
    toast.success(`${approve ? 'Approved' : 'Rejected'} ${succeeded.length}, failed ${failed}`);
    if (firstError) {
      toast.error(
        apiErrorMessage(firstError, `Failed to ${approve ? 'approve' : 'reject'} ${entityLabel}.`),
      );
    }
    setSelectedIds((ids) => ids.filter((id) => !succeeded.includes(id)));
    invalidate();
  }

  return { reviewing, handleBulkReview };
}

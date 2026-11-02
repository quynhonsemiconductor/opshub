import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { FormActions, FormError, FormField, Input, Modal } from '@/shared/ui';
import type { JobRank } from './role.types';
import { RANK_NAME_MAX_LENGTH, WFH_WEEKLY_DAYS_MAX } from './rank.constants';
import {
  benefitsWithWfhWeeklyDays,
  parseWfhWeeklyDays,
  wfhWeeklyDaysOf,
} from './rank-benefits.helpers';

/**
 * Create a job rank or edit one, with the work-from-home days a week it entitles its holders to.
 *
 * Saving is up to two calls: the rank itself (create, or a patch when its name or order changed) and the
 * benefit set (replaced whole, with only the work-from-home allowance touched). The allowance is optional;
 * leaving it empty means the rank carries none, which the API treats as no work-from-home allowance.
 *
 * Args:
 *   open: Whether the dialog is shown.
 *   rank: The rank to edit; absent for a create.
 *   onClose: Called when the dialog should close.
 *   onSuccess: Called after the rank was saved, so the list can reload.
 */
export function RankModal({
  open,
  rank,
  onClose,
  onSuccess,
}: {
  open: boolean;
  rank?: JobRank;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const editing = !!rank;
  const [ordinal, setOrdinal] = useState(String(rank?.ordinal ?? ''));
  const [name, setName] = useState(rank?.name ?? '');
  const [allowanceText, setAllowanceText] = useState(
    rank ? String(wfhWeeklyDaysOf(rank) ?? '') : '',
  );
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const allowance = parseWfhWeeklyDays(allowanceText, WFH_WEEKLY_DAYS_MAX);
      if (!allowance.ok) throw new Error(allowance.message);
      const ordinalNumber = Number(ordinal);
      if (!Number.isInteger(ordinalNumber) || ordinalNumber < 1) {
        throw new Error('The order is a whole number from 1, the most junior rank.');
      }
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('Give the rank a name.');

      let rankId = rank?.id;
      if (!rank) {
        const { data, error: err } = await api.POST('/v1/job-ranks', {
          body: { ordinal: ordinalNumber, name: trimmedName },
        });
        if (err || !data) throw new Error(apiErrorMessage(err, 'Failed to create the rank.'));
        rankId = data.id;
      } else if (rank.ordinal !== ordinalNumber || rank.name !== trimmedName) {
        const { error: err } = await api.PATCH('/v1/job-ranks/{id}', {
          params: { path: { id: rank.id } },
          body: { ordinal: ordinalNumber, name: trimmedName },
        });
        if (err) throw new Error(apiErrorMessage(err, 'Failed to update the rank.'));
      }

      const allowanceChanged = allowance.value !== (rank ? wfhWeeklyDaysOf(rank) : null);
      if (rankId && allowanceChanged) {
        const { error: err } = await api.PUT('/v1/job-ranks/{id}/benefits', {
          params: { path: { id: rankId } },
          body: { benefits: benefitsWithWfhWeeklyDays(rank ?? { benefits: [] }, allowance.value) },
        });
        if (err)
          throw new Error(apiErrorMessage(err, 'Failed to save the work-from-home allowance.'));
      }
    },
    onSuccess: () => {
      toast.success(editing ? 'Rank updated' : 'Rank created');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit rank' : 'New rank'} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Order" htmlFor="rank-ordinal" required hint="1 is the most junior.">
            <Input
              id="rank-ordinal"
              type="number"
              min={1}
              required
              value={ordinal}
              onChange={(e) => setOrdinal(e.target.value)}
            />
          </FormField>
          <div className="col-span-2">
            <FormField label="Name" htmlFor="rank-name" required>
              <Input
                id="rank-name"
                required
                maxLength={RANK_NAME_MAX_LENGTH}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Senior"
              />
            </FormField>
          </div>
        </div>
        <FormField
          label="Work-from-home days per week"
          htmlFor="rank-wfh"
          hint="Leave empty for none. Employees of this rank may log at most this many working days a week."
        >
          <Input
            id="rank-wfh"
            inputMode="numeric"
            value={allowanceText}
            onChange={(e) => setAllowanceText(e.target.value)}
            placeholder="0"
          />
        </FormField>
        <FormError message={error} />
        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel={editing ? 'Save changes' : 'Create rank'}
        />
      </form>
    </Modal>
  );
}

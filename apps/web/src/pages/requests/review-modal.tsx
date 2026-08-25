import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { FormActions, FormField, Modal, Textarea, humanizeStatus } from '@/shared/ui';
import type { RequestItemResponse } from '@/shared/api/types';

/**
 * Approve or reject one request.
 *
 * A REJECTION REQUIRES A REASON and an approval does not: a rejection is a decision somebody has to
 * act on, and "no" with no explanation makes the next step unguessable.
 */
export function ReviewModal({
  request,
  action,
  onClose,
  onSuccess,
}: {
  request: RequestItemResponse;
  action: 'approve' | 'reject';
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const isApprove = action === 'approve';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isApprove && !note.trim()) {
      setErr('A reason is required for rejection.');
      return;
    }
    setLoading(true);
    setErr('');

    const endpoint = isApprove ? '/v1/requests/{id}/approve' : '/v1/requests/{id}/reject';
    const { error } = await api.POST(endpoint, {
      params: { path: { id: request.id } },
      body: { note: note.trim() || undefined },
    });
    setLoading(false);
    if (error) {
      /*
       * THE API'S OWN SENTENCE, because it is the one that tells the approver what to do next. The
       * engine refuses a decision for reasons it words carefully — `REQUEST_SOD_VIOLATION` for your
       * own request, `REQUEST_NOT_PENDING` for one already decided, a missing step permission — and
       * this branch replaced all of them with "please try again", which is advice that cannot work:
       * every one of those refusals is permanent.
       *
       * `apiErrorMessage` was already imported and used by the cancel path in the page that opens
       * this modal, so the convention existed and this slot bypassed it.
       */
      setErr(apiErrorMessage(error, 'Failed to process the request.'));
      return;
    }

    toast.success(isApprove ? 'Request approved' : 'Request rejected');
    onSuccess();
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={isApprove ? 'Approve request' : 'Reject request'}
      description={`${humanizeStatus(request.type)} · step ${request.currentStep} of ${request.totalSteps}`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <FormField
          label={isApprove ? 'Note' : 'Reason'}
          htmlFor="review-note"
          required={!isApprove}
          error={err}
        >
          <Textarea
            id="review-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            error={err}
            placeholder={
              isApprove ? 'Add an approval note…' : 'Explain why this is being rejected…'
            }
          />
        </FormField>

        <FormActions
          loading={loading}
          onClose={onClose}
          submitLabel={isApprove ? 'Approve' : 'Reject'}
          pendingLabel="Working…"
          variant={isApprove ? 'primary' : 'danger'}
        />
      </form>
    </Modal>
  );
}

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { useUpload } from '@/shared/api/use-upload';
import { Button, ConfirmDialog, FormError, PanelState, RowActions, Tooltip } from '@/shared/ui';
import { formatDateTime } from '@/shared/lib/format';
import { CERTIFICATE_ACCEPT } from './training.types';
import { useCertificates } from './use-training';
import type { Certificate } from './training.types';

/**
 * The certificates attached to one training record.
 *
 * A COLLECTION, which is why this is not `FileUploadWidget`. That widget models one file replacing
 * another — an avatar, a photo — and shows a preview of the current one. A record can carry several
 * certificates (the completion letter, the provider's PDF, a scan of the signed attendance sheet), so
 * the interaction is a list with an add, and each row keeps its own download and delete.
 *
 * THE DOWNLOAD IS TWO STEPS. `GET …/download` returns a short-lived URL rather than the bytes, so the
 * click fetches the URL and then opens it. Opening our own endpoint directly would work only while the
 * session cookie travelled with a top-level navigation, which is exactly what `SameSite` stops.
 *
 * The upload goes through `useUpload`, which was broken until this branch: it sent no CSRF header, so
 * every presign in the SPA answered 403. Certificates would have been the fourth dead upload surface.
 *
 * AUTHORIZATION AND LIFECYCLE ARRIVE AS SEPARATE PROPS, and the split is deliberate. There used to be one
 * `canManage`, and its only caller passed `selected.status !== 'revoked'` into it — so the panel believed
 * it had been told who the reader was when it had been told what state the record was in, and every
 * holder of `training.read` got Attach and Delete on records that were not theirs. Two booleans cannot be
 * folded into one here without losing a real case: a record can be writable and revoked, or unwritable
 * and live, and the reader must be told which.
 *
 * `canPost` ALSO GOVERNS THE LIST, not just the buttons. `GET …/certificates` runs through the same
 * `assertMayAttach` as the presign, so a reader who may not attach may not enumerate either — firing that
 * request anyway would spend a round trip to render a 403 as "Failed to load the certificates", which
 * blames the network for a permission.
 */
export function CertificatesPanel({
  recordId,
  canPost,
  frozen,
}: {
  recordId: string;
  /**
   * AUTHORIZATION: may this caller read and write this record's evidence? Mirrors `assertMayAttach` —
   * their own record, or `training.manage`. Never a status expression; that is what `frozen` is for.
   */
  canPost: boolean;
  /**
   * LIFECYCLE: a revoked record is settled and takes no further evidence. Independent of who is asking.
   *
   * This once said "ours rather than the API's — the service does not refuse a presign on a revoked
   * record", and that was true and was the defect: the rule shipped in the browser only, so anybody
   * with a shell had a different product. `presignCertificate` and `confirmCertificate` now both refuse
   * with `TRAINING_RECORD_NOT_VERIFIABLE`. The prop stays because withholding the control and giving
   * the reason is better than letting somebody choose a file and meet a 412 — not because it is the
   * only thing standing in the way.
   *
   * IT GATES ACCEPTANCE, NOT REMOVAL. Attaching is refused; deleting is not. Revocation settles what the
   * evidence PROVES, and says nothing about whether a particular file may exist — an erasure request or a
   * mis-uploaded document is no less urgent afterwards, `removeCertificate` permits it, and the audit
   * trail records it. See the booleans in the body for why withholding it would have been worse.
   */
  frozen: boolean;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useUpload();
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Certificate | null>(null);

  // `null` skips the request entirely — see the docblock: the list is behind the same check the presign is.
  const certificates = useCertificates(canPost ? recordId : null);
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['training', 'certificates', recordId] });

  async function attach(file: File) {
    setError('');
    try {
      await upload({
        file,
        presignUrl: `/v1/training/records/${recordId}/certificates/presign`,
        // The file id belongs in the PATH for this endpoint, and the body is empty — unlike the avatar
        // and photo endpoints, which take it in the body.
        confirmUrl: (fileId) => `/v1/training/records/${recordId}/certificates/${fileId}/confirm`,
        confirmBody: () => ({}),
      });
      toast.success('Certificate attached');
      invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    }
  }

  async function download(certificate: Certificate) {
    const { data, error: err } = await api.GET(
      '/v1/training/records/{id}/certificates/{fileId}/download',
      { params: { path: { id: recordId, fileId: certificate.fileId } } },
    );
    if (err || !data?.url) {
      toast.error(apiErrorMessage(err, 'Could not get a download link.'));
      return;
    }
    // `noopener` on a window we did not build the contents of.
    window.open(data.url, '_blank', 'noopener,noreferrer');
  }

  async function remove() {
    if (!deleting) return;
    const { error: err } = await api.DELETE('/v1/training/records/{id}/certificates/{fileId}', {
      params: { path: { id: recordId, fileId: deleting.fileId } },
    });
    setDeleting(null);
    if (err) {
      toast.error(apiErrorMessage(err, 'Failed to delete the certificate.'));
      return;
    }
    toast.success('Certificate deleted');
    invalidate();
  }

  const rows = certificates.data ?? [];
  /*
   * ATTACHING AND REMOVING ARE NOT THE SAME PERMISSION QUESTION, and folding them into one boolean got
   * the second one wrong.
   *
   * `frozen` is about ACCEPTANCE: a revoked record no longer supports the claim its evidence was filed
   * for, so it takes nothing new — and `presignCertificate`/`confirmCertificate` refuse it server-side
   * with `TRAINING_RECORD_NOT_VERIFIABLE`.
   *
   * REMOVAL IS ERASURE, and revocation does not extinguish the reasons for it. A certificate can hold
   * personal data subject to an Art. 17 request, or be a mis-upload — somebody else's passport scan
   * attached to the wrong record. Neither becomes less urgent because the record was later revoked.
   * `removeCertificate` allows it and records `TRAINING_CERTIFICATE_REMOVED` in the audit trail, so the
   * deletion is answerable to the same audit that asks what was on file.
   *
   * WITHHOLDING IT HERE DID NOT MAKE THE FILE IMMUTABLE — it made the only route to erasing it an S3
   * console or a SQL statement, which leaves no trail at all. A constraint whose only compliant
   * workaround is to leave the product is worse than the thing it prevents.
   *
   * Only lifecycle is left in this expression: authorization was decided by the early return above, so
   * repeating `canPost` here would be a guard that guards nothing.
   */
  const acceptsNewEvidence = !frozen;

  /*
   * SAID, NOT SHOWN AS AN EMPTY SECTION. A reader looking at somebody else's record cannot otherwise
   * tell a completion with no evidence from one whose evidence they may not see, and the first reading
   * is the dangerous one: it looks like a compliance gap that is not there. The reason is also
   * actionable — a training administrator can grant the code — which is why it is a sentence rather
   * than a disabled button.
   */
  /*
   * AUTHORIZATION IS SPENT HERE, and nowhere below.
   *
   * Everything after this line runs only for a reader who may write this record, so a second `canPost`
   * further down guards nothing. Both existed in the first version of this split and mutation testing
   * killed them as dead logic — setting either to `true` changed no observable behaviour. They read as
   * guards, which in this panel is the exact bug being fixed: the original single `canManage` looked
   * like an authorization check and was a status expression.
   *
   * So the structure is deliberate and worth keeping intact: ONE authorization decision at the top,
   * LIFECYCLE decisions below it. `records-tab.spec.tsx` pins this return, so a later change that
   * renders a read-only list for non-posters fails a test rather than silently handing them the buttons.
   */
  if (!canPost) {
    return (
      <p className="text-xs text-fg-subtle">
        Certificates on somebody else&rsquo;s record are visible to training administrators only.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ConfirmDialog
        open={!!deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={remove}
        title="Delete this certificate?"
        description="The file is removed from the record. If it was the only evidence of this completion, the record keeps the completion but loses its proof."
        confirmLabel="Delete certificate"
        variant="danger"
      />

      <PanelState
        query={certificates}
        count={rows.length}
        empty="No certificate attached"
        error="Failed to load the certificates."
      />

      {rows.map((certificate) => (
        <div
          key={certificate.fileId}
          className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <FileText className="h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-fg">{certificate.fileName}</p>
            <p className="truncate text-xs text-fg-subtle">
              {formatKilobytes(certificate.sizeBytes)} · {formatDateTime(certificate.attachedAt)}
            </p>
          </div>
          <RowActions>
            <Tooltip content="Download">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Download ${certificate.fileName}`}
                onClick={() => download(certificate)}
              >
                <Download className="h-3.5 w-3.5" strokeWidth={2} />
              </Button>
            </Tooltip>
            {/* Download stays for anybody who got this far — reading your own evidence, or evidence you
                administer, is the whole point of the list. Deleting is a write. */}
            {/*
                UNGATED HERE, AND THAT IS NOT AN OVERSIGHT. Authorization is already spent: `!canPost`
                returns above, so nothing below it renders for a reader who may not write this record —
                which is why the list itself is behind the same check. A `mayRemove = canPost` here was
                the first version of this, and mutation testing killed it as dead logic: setting it to
                `true` changed no observable behaviour, because the early return had already decided.
                A boolean that reads as a guard and guards nothing is the shape of bug this panel was
                built to remove.

                Lifecycle deliberately does NOT appear: `frozen` gates acceptance, not erasure.
            */}
            <Tooltip content="Delete">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${certificate.fileName}`}
                onClick={() => setDeleting(certificate)}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
              </Button>
            </Tooltip>
          </RowActions>
        </div>
      ))}

      {acceptsNewEvidence && (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={2} />
            {uploading ? 'Uploading…' : 'Attach certificate'}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept={CERTIFICATE_ACCEPT}
            className="hidden"
            aria-label="Certificate file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared so the same file can be chosen again after a failure.
              e.target.value = '';
              if (file) void attach(file);
            }}
          />
        </>
      )}

      {/* The OTHER half of the old single boolean, now able to speak for itself. Somebody who may write
          to this record still gets told why they cannot, instead of hunting for a button that a status
          removed — and it distinguishes "no evidence was ever attached" from "this record is closed". */}
      {canPost && frozen && (
        <p className="text-xs text-fg-subtle">
          This record was revoked, so it takes no further evidence. What is already attached stays
          readable, because an audit asks what was on file at the time — and can still be removed if
          it must be, which is recorded.
        </p>
      )}

      <FormError message={error} />
    </div>
  );
}

/** Sizes are shown in kB: certificates are documents, and "1.2 MB" hides nothing useful at this scale. */
function formatKilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

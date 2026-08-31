import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GraduationCap, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions, courseOptions } from '@/shared/api/picker-sources';
import {
  Badge,
  Button,
  DataTable,
  EntityDetailPanel,
  EntityPicker,
  PaginationFooter,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  TabToolbar,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { useAuthStore } from '@/shared/api/auth-store';
import { formatDate, formatDateTime, orDash } from '@/shared/lib/format';
import { CertificatesPanel } from './certificates-panel';
import { RecordCompletionModal, RevokeRecordModal } from './record-modals';
import { RECORD_STATUS_FILTERS, EXPIRY_HORIZON_DAYS } from './training.types';
import { useCourseLookup, useRecords } from './use-training';
import type { TrainingRecord } from './training.types';

/**
 * Completed training, and what has lapsed.
 *
 * VERIFYING IS THE CONTROL AN AUDIT ASKS ABOUT. Anybody with `training.manage` can record a completion;
 * verification is a second person saying they saw the evidence, and it is stamped with who and when. So
 * the column shows the verifier rather than a tick: "verified" without a name is not evidence.
 *
 * EXPIRY IS DERIVED, NOT STORED. A record is expired when `expiresOn` has passed, which is why the filter
 * sends a DATE to the API rather than asking for a status the database would have to keep up to date with
 * a nightly job.
 *
 * THREE WRITE CONTROLS, ALL `training.manage`. `POST /training/records`, `POST /training/records/{id}/verify`
 * and `POST /training/records/{id}/revoke` each carry `@RequirePermission('training.manage')`. `ROLE.AUDITOR`
 * holds `training.read` and no manage code, so before this gate the one role whose whole job is to read
 * competency evidence was offered Verify and Revoke on every row — an auditor able to attest to the
 * evidence they are auditing is the exact separation the verify route's own docblock exists to keep.
 *
 * CERTIFICATES ARE GATED DIFFERENTLY, and see the `CertificatesPanel` call at the bottom of this file for
 * why: their routes are authorized in the service on OWNERSHIP OR the manage code, not on the code alone.
 */
export function RecordsTab() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('training.manage');
  // The signed-in principal, for the ownership half of the certificate rule below. `useAuthStore` rather
  // than a second `/me` query, which is where `reviews-tab.tsx` reads the same fact from.
  const me = useAuthStore((state) => state.user);
  const [status, setStatus] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [courseId, setCourseId] = useState('');
  const [expiringSoon, setExpiringSoon] = useState(false);
  const [recording, setRecording] = useState(false);
  const [revoking, setRevoking] = useState<TrainingRecord | null>(null);
  const [selected, setSelected] = useState<TrainingRecord | null>(null);

  const courses = useCourseLookup();
  const records = useRecords({
    employeeId,
    courseId,
    status,
    expiringSoon,
    currentOnly: false,
    limit: list.limit,
    offset: list.offset,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['training'] });
  const courseTitle = (id: string) => courses.data?.get(id)?.title ?? id;
  const courseCode = (id: string) => courses.data?.get(id)?.code ?? '';

  async function verify(record: TrainingRecord) {
    const { error } = await api.POST('/v1/training/records/{id}/verify', {
      params: { path: { id: record.id } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to verify the record.'));
      return;
    }
    toast.success('Record verified');
    invalidate();
  }

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  const columns: DataTableColumn<TrainingRecord>[] = [
    {
      key: 'course',
      header: 'Course',
      cell: (record) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{courseTitle(record.courseId)}</p>
          <p className="truncate font-mono text-xs text-fg-subtle">{courseCode(record.courseId)}</p>
        </div>
      ),
    },
    {
      key: 'employee',
      header: 'Employee',
      // The NAME, not `employeeId`. This column is the only thing on the row that says which person
      // the record is about, and thirty-six characters of uuid answered that with nothing.
      cell: (record) => (
        <span className="text-xs text-fg-muted">{orDash(record.employeeName)}</span>
      ),
      hideOnMobile: true,
    },
    { key: 'completed', header: 'Completed', cell: (record) => formatDate(record.completedOn) },
    {
      key: 'expires',
      header: 'Expires',
      // No expiry is a property of the course, not a gap in the record.
      cell: (record) =>
        record.expiresOn ? (
          formatDate(record.expiresOn)
        ) : (
          <span className="text-xs text-fg-subtle">Never</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'result',
      header: 'Result',
      cell: (record) =>
        record.result ? (
          <Badge>
            {record.result}
            {record.score ? ` · ${record.score}` : ''}
          </Badge>
        ) : (
          orDash(null)
        ),
      hideOnMobile: true,
    },
    {
      key: 'verified',
      header: 'Verified',
      cell: (record) =>
        record.verifiedAt ? (
          <span className="text-xs text-fg-muted">{formatDate(record.verifiedAt)}</span>
        ) : (
          <span className="text-xs text-fg-subtle">Not verified</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (record) => (
        <StatusBadge tone={statusTone(record.status)}>{humanizeStatus(record.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      // The PERMISSION wraps the whole cell and the STATUS rules stay inside it. Both are needed and they
      // answer different questions: `canManage` is whether this person may ever write to a record, and
      // `status`/`verifiedAt` are whether THIS record has anything left to do. Collapsing them into one
      // expression is the mistake fixed further down this file.
      cell: (record) =>
        canManage ? (
          <RowActions>
            {/* A revoked record cannot be verified, and a verified one does not need it twice. */}
            {record.status !== 'revoked' && !record.verifiedAt && (
              <RowAction tone="success" onClick={() => void verify(record)}>
                Verify
              </RowAction>
            )}
            {record.status !== 'revoked' && (
              <RowAction tone="danger" onClick={() => setRevoking(record)}>
                Revoke
              </RowAction>
            )}
          </RowActions>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <RecordCompletionModal
        open={recording}
        onClose={() => setRecording(false)}
        onSuccess={invalidate}
      />
      {revoking && (
        <RevokeRecordModal
          record={revoking}
          courseTitle={courseTitle(revoking.courseId)}
          onClose={() => setRevoking(null)}
          onSuccess={invalidate}
        />
      )}

      <TabToolbar
        filter={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label="Filter by status"
              options={RECORD_STATUS_FILTERS.map((option) => ({ ...option }))}
              value={status}
              onChange={(value) => applyFilter(() => setStatus(value))}
            />
            {/* A SECOND AXIS, not another status: a record can be valid AND expiring, and the two
                questions "what is valid" and "what lapses soon" are asked by different people. */}
            <Button
              variant={expiringSoon ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={expiringSoon}
              onClick={() => applyFilter(() => setExpiringSoon(!expiringSoon))}
            >
              Expiring in {EXPIRY_HORIZON_DAYS} days
            </Button>
            <div className="w-52">
              <EntityPicker
                ariaLabel="Filter by employee"
                queryKey="active-employees"
                value={employeeId}
                onChange={(value) => applyFilter(() => setEmployeeId(value))}
                fetchOptions={activeEmployeeOptions}
                placeholder="Any employee"
              />
            </div>
            <div className="w-52">
              <EntityPicker
                ariaLabel="Filter by course"
                queryKey="courses"
                value={courseId}
                onChange={(value) => applyFilter(() => setCourseId(value))}
                fetchOptions={courseOptions}
                placeholder="Any course"
              />
            </div>
          </div>
        }
        action={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setRecording(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Record completion
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={records.data?.data}
        isLoading={records.isLoading}
        isError={records.isError}
        errorMessage="Failed to load training records."
        emptyMessage="No training records match these filters"
        emptyIcon={GraduationCap}
        emptyAction={
          expiringSoon || !canManage ? undefined : (
            <Button variant="primary" size="sm" onClick={() => setRecording(true)}>
              <Plus className="h-3.5 w-3.5" /> Record your first completion
            </Button>
          )
        }
        onRowClick={setSelected}
        isRowActive={(record) => record.id === selected?.id}
      />

      <PaginationFooter
        pageInfo={records.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="record"
      />

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? courseTitle(selected.courseId) : 'Record'}
        description={selected ? courseCode(selected.courseId) : undefined}
        headerActions={
          // Same conjunction as the row cell, for the same reason: the drawer is a second entry point to
          // the same route, and a gate applied in one place and not the other is not a gate.
          selected && canManage && selected.status !== 'revoked' && !selected.verifiedAt ? (
            <PanelAction tone="success" onClick={() => void verify(selected)}>
              Verify
            </PanelAction>
          ) : undefined
        }
        items={
          selected
            ? [
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                { label: 'Completed', value: formatDate(selected.completedOn) },
                {
                  label: 'Expires',
                  value: selected.expiresOn ? formatDate(selected.expiresOn) : 'Never',
                },
                { label: 'Result', value: orDash(selected.result) },
                { label: 'Score', value: orDash(selected.score) },
                {
                  label: 'Verified',
                  value: selected.verifiedAt
                    ? `${formatDateTime(selected.verifiedAt)} by ${selected.verifiedBy ?? 'unknown'}`
                    : 'Not verified',
                },
                {
                  label: 'Employee',
                  value: (
                    <span>
                      {orDash(selected.employeeName)}
                      {/* The uuid stays here, secondary: the drawer has room, and it is what somebody
                          quotes in a ticket. */}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.employeeId}
                      </span>
                    </span>
                  ),
                },
                // Only shown when it happened: an empty "Revoked because" row on a valid record reads
                // as a record that was revoked for no stated reason.
                ...(selected.revokedReason
                  ? [{ label: 'Revoked because', value: selected.revokedReason, wide: true }]
                  : []),
                ...(selected.supersededById
                  ? [
                      {
                        label: 'Superseded by',
                        value: <span className="font-mono text-xs">{selected.supersededById}</span>,
                      },
                    ]
                  : []),
                ...(selected.notes ? [{ label: 'Notes', value: selected.notes, wide: true }] : []),
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'training_record' } : undefined
        }
      >
        {selected && (
          <SlideOverSection title="Certificates">
            {/*
              TWO PROPS, BECAUSE THESE ARE TWO DIFFERENT QUESTIONS. This read
              `canManage={selected.status !== 'revoked'}` — a status expression handed to a permission
              prop, which is the same class of bug as the ungated buttons above and worse for being
              disguised as a check. It meant every holder of `training.read` was shown Attach and Delete
              on anybody's record, and it meant a record could never be "writable but revoked", because
              one boolean cannot say two things.
                · `canPost` is AUTHORIZATION: may this person write to this record's evidence at all?
                  `assertMayAttach` in the training controller answers "your own record, or
                  `training.manage`", so the ownership half is real and must not be dropped — an employee
                  uploading the certificate for a course they took needs no permission code, and gating
                  this on `canManage` alone would have broken the ordinary flow while fixing the leak.
                · `frozen` is LIFECYCLE: a revoked record is settled evidence and takes no more of it.
                  It has nothing to do with who is asking. This used to add "and it is ours rather than
                  the API's — the service checks status on verify and revoke but not on a presign", which
                  was an accurate description of a hole: the rule was enforced by the component drawing
                  the button and by nothing else. `presignCertificate` and `confirmCertificate` now both
                  refuse a revoked record. The prop remains because a withheld control with a stated
                  reason beats a 412 discovered after choosing a file.
            */}
            <CertificatesPanel
              recordId={selected.id}
              canPost={canManage || selected.employeeId === me?.sub}
              frozen={selected.status === 'revoked'}
            />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </div>
  );
}

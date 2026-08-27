import { useState } from 'react';
import { AlertTriangle, GraduationCap, ShieldCheck } from 'lucide-react';
import {
  Badge,
  DataTable,
  EntityDetailPanel,
  SlideOverSection,
  StatCard,
  StatGrid,
  StatusBadge,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useAuthStore } from '@/shared/api/auth-store';
import { formatDate, formatDateTime, orDash } from '@/shared/lib/format';
import { CertificatesPanel } from './certificates-panel';
import { useCourseLookup, useMyGaps, useMyTraining } from './use-training';
import type { CompetencyGap, TrainingRecord } from './training.types';

/**
 * The caller's own training — the only tab an employee can use.
 *
 * SELF-SCOPED, so it holds no permission check. `GET /v1/training/me` is keyed on the caller's own id by
 * the API, which is what lets an employee — who holds NO permission codes at all in this product's model
 * — see their own record without being able to see anybody else's. A UI check here would be decoration
 * on top of the real rule.
 *
 * GAPS COME FIRST because they are the only part that asks the reader to do something. The history below
 * is reference; the two tiles at the top are the answer to "am I up to date".
 *
 * AND THE HISTORY ROWS OPEN, which is the entry point this tab was shipped without.
 *
 * `assertMayAttach` in the training controller permits an employee to attach a certificate to their OWN
 * record holding NO permission code — the record already names who it belongs to, and its docblock calls
 * that "the ordinary flow". There was nowhere in the product to perform it. The only `CertificatesPanel`
 * was in the Records tab, which needs `training.read`; `ROLE.EMPLOYEE` holds nothing, so the tab is not
 * even rendered for them. The flow the API was built for was unreachable by the people it was built for,
 * and "Current certificates" — a count tile — was the whole of what this tab said about evidence.
 *
 * REUSING `CertificatesPanel` RATHER THAN A SECOND UPLOADER. It already models the two axes this needs
 * (`canPost` for who is asking, `frozen` for what state the record is in), already knows the quirk that
 * the confirm endpoint takes the file id in the PATH, and already renders the list, the per-file download
 * and the delete. A second uploader here would be a second place for the presign URL, the accept list and
 * the revoked rule to drift — and the panel's own history is that of a single boolean that drifted.
 *
 * NO ACTIVITY SECTION on this drawer, unlike the Records tab's. `ActivityTimeline` reads
 * `GET /v1/audit-logs`, which is `@RequirePermission('audit.read')` — a code an employee does not hold —
 * so including it would render "Activity" above a permanent failure for every reader of this tab.
 * `EntityDetailPanel` omits the section entirely when `activity` is absent, which is exactly the case.
 */
export function MyTrainingTab() {
  const records = useMyTraining();
  const gaps = useMyGaps();
  const courses = useCourseLookup();
  /*
   * The signed-in principal, read the same way the Records tab reads it.
   *
   * `GET /v1/training/me` is `@SelfScoped` and keyed on the caller's own id, so every row here is
   * already theirs — but `canPost` states a fact about THIS reader and THIS record, and passing a bare
   * `true` would be asserting that fact rather than checking it. That is the shape of the bug this panel
   * was split apart to fix: a prop that looked like a check and was an assumption. Comparing the ids
   * costs nothing and keeps the claim true if `/me` ever grows a "records I manage" mode.
   */
  const me = useAuthStore((state) => state.user);
  const [selected, setSelected] = useState<TrainingRecord | null>(null);

  const courseTitle = (id: string) => courses.data?.get(id)?.title ?? id;
  const courseCode = (id: string) => courses.data?.get(id)?.code ?? '';

  const mine = records.data ?? [];
  const myGaps = gaps.data ?? [];
  const mandatoryGaps = myGaps.filter((gap) => gap.kind === 'mandatory').length;
  const valid = mine.filter((record) => record.status === 'valid').length;

  const gapColumns: DataTableColumn<CompetencyGap>[] = [
    {
      key: 'course',
      header: 'Course',
      cell: (gap) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{gap.courseTitle}</p>
          <p className="truncate font-mono text-xs text-fg-subtle">{gap.courseCode}</p>
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      cell: (gap) => (
        <Badge tone={gap.kind === 'mandatory' ? 'red' : 'blue'}>{humanizeStatus(gap.kind)}</Badge>
      ),
    },
    {
      key: 'reason',
      header: 'Why',
      cell: (gap) => <StatusBadge tone="amber">{humanizeStatus(gap.reason)}</StatusBadge>,
    },
    {
      key: 'last',
      header: 'Last completed',
      cell: (gap) =>
        gap.completedOn ? (
          formatDate(gap.completedOn)
        ) : (
          <span className="text-xs text-fg-subtle">Never</span>
        ),
    },
  ];

  const recordColumns: DataTableColumn<TrainingRecord>[] = [
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
    { key: 'completed', header: 'Completed', cell: (record) => formatDate(record.completedOn) },
    {
      key: 'expires',
      header: 'Expires',
      cell: (record) =>
        record.expiresOn ? (
          formatDate(record.expiresOn)
        ) : (
          <span className="text-xs text-fg-subtle">Never</span>
        ),
    },
    {
      key: 'result',
      header: 'Result',
      cell: (record) => orDash(record.result),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (record) => (
        <StatusBadge tone={statusTone(record.status)}>{humanizeStatus(record.status)}</StatusBadge>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <StatGrid>
        <StatCard
          label="Outstanding mandatory"
          value={mandatoryGaps}
          icon={AlertTriangle}
          tone="red"
          alert
          loading={gaps.isLoading}
        />
        <StatCard
          label="Current certificates"
          value={valid}
          icon={ShieldCheck}
          tone="green"
          loading={records.isLoading}
        />
        <StatCard
          label="Records held"
          value={mine.length}
          icon={GraduationCap}
          loading={records.isLoading}
        />
      </StatGrid>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          What I still need
        </h2>
        <DataTable
          columns={gapColumns}
          rows={myGaps}
          isLoading={gaps.isLoading}
          isError={gaps.isError}
          errorMessage="Failed to load your outstanding training."
          emptyMessage="Nothing outstanding — every course your position requires is current"
          emptyIcon={ShieldCheck}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          My training history
        </h2>
        {/* SAID, BECAUSE A CLICKABLE ROW ANNOUNCES NOTHING. The upload is the point of this section and it
            lives one click in; a reader who cannot see that there is anything to open has the same
            problem as a reader with no button at all. One sentence for the whole table rather than a
            control per row, per the kit's rule on a fact that is the same on every row. */}
        <p className="text-xs text-fg-subtle">
          Open a row to attach your certificate or completion letter.
        </p>
        <DataTable
          columns={recordColumns}
          rows={mine}
          isLoading={records.isLoading}
          isError={records.isError}
          errorMessage="Failed to load your training records."
          emptyMessage="No training recorded yet"
          emptyIcon={GraduationCap}
          onRowClick={setSelected}
          isRowActive={(record) => record.id === selected?.id}
        />
      </section>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? courseTitle(selected.courseId) : 'Record'}
        description={selected ? courseCode(selected.courseId) : undefined}
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
                  // WHO attested, not just that somebody did: an employee looking at their own record is
                  // the person most likely to need to chase it, and "Not verified" is the actionable half.
                  label: 'Verified',
                  value: selected.verifiedAt
                    ? formatDateTime(selected.verifiedAt)
                    : 'Not verified yet',
                },
                // Only when it happened. An empty "Revoked because" row on a valid record reads as a
                // record revoked for no stated reason — and this reader is the one it is about.
                ...(selected.revokedReason
                  ? [{ label: 'Revoked because', value: selected.revokedReason, wide: true }]
                  : []),
                ...(selected.notes ? [{ label: 'Notes', value: selected.notes, wide: true }] : []),
              ]
            : []
        }
      >
        {selected && (
          <SlideOverSection title="Certificates">
            {/*
              THE SAME TWO PROPS THE RECORDS TAB PASSES, answering the same two questions — see the panel's
              own docblock for why they cannot be one boolean.
                · `canPost` is AUTHORIZATION. `assertMayAttach` allows "your own record, or
                  `training.manage`", and the OWNERSHIP half is the only half that applies here: this
                  reader may hold no permission code whatsoever, which is the entire reason this tab
                  exists. Gating the upload on a permission would rebuild the defect — the flow would
                  again be reachable only by administrators, who never needed it.
                · `frozen` is LIFECYCLE, and it is now enforced on the server as well: the service refuses
                  a presign AND a confirm on a revoked record. This still passes it, because the panel
                  needs to withhold the button and say why rather than let the reader discover a 412.
            */}
            <CertificatesPanel
              recordId={selected.id}
              canPost={selected.employeeId === me?.sub}
              frozen={selected.status === 'revoked'}
            />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </div>
  );
}

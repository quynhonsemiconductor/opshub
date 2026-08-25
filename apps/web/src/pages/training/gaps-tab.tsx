import { useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { activeEmployeeOptions, positionOptions } from '@/shared/api/picker-sources';
import {
  Badge,
  Button,
  DataTable,
  EntityPicker,
  StatCard,
  StatGrid,
  StatusBadge,
  TabToolbar,
  humanizeStatus,
  type DataTableColumn,
} from '@/shared/ui';
import { formatDate, orDash } from '@/shared/lib/format';
import { useGaps } from './use-training';
import type { CompetencyGap } from './training.types';

/**
 * The competency gap report: who is missing training their position requires.
 *
 * COMPUTED BY THE API, NOT HERE. The join is requirements × records × grace period × today, and doing it
 * client-side would mean fetching every record for every employee and reimplementing the expiry rule —
 * the same rule, in a second place, drifting the first time grace days change.
 *
 * `reason` IS THE ANSWER, so it gets its own column: "never completed" and "expired on 4 Mar" are
 * different problems with different fixes, and a report that only said "gap" would send somebody to look
 * both up. Recommended courses are excluded by default because a report where every suggestion looks
 * like a finding is a report nobody reads twice.
 */
export function GapsTab() {
  const [employeeId, setEmployeeId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [includeRecommended, setIncludeRecommended] = useState(false);

  const gaps = useGaps({ employeeId, positionId, includeRecommended });
  const rows = gaps.data ?? [];
  const mandatory = rows.filter((gap) => gap.kind === 'mandatory').length;

  const columns: DataTableColumn<CompetencyGap>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (gap) => (
        <span className="font-mono text-xs font-medium text-fg">{gap.courseCode}</span>
      ),
    },
    { key: 'title', header: 'Course', cell: (gap) => gap.courseTitle },
    {
      key: 'employee',
      header: 'Employee',
      // The NAME. This report is filtered by POSITION as often as by employee, and in that shape it
      // is a list of different people against the same course — so the column that says which of
      // them is the whole output, and it cannot be a uuid.
      cell: (gap) => <span className="text-xs text-fg-muted">{orDash(gap.employeeName)}</span>,
      hideOnMobile: true,
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
      // A gap with a completion date behind it is a LAPSE; one without is training that never happened.
      cell: (gap) =>
        gap.completedOn ? (
          formatDate(gap.completedOn)
        ) : (
          <span className="text-xs text-fg-subtle">Never</span>
        ),
    },
    {
      key: 'expired',
      header: 'Expired',
      cell: (gap) =>
        gap.expiresOn ? (
          formatDate(gap.expiresOn)
        ) : (
          <span className="text-xs text-fg-subtle">—</span>
        ),
      hideOnMobile: true,
    },
  ];

  const chosen = !!(employeeId || positionId);

  return (
    <div className="flex flex-col gap-4">
      <TabToolbar
        filter={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-56">
              <EntityPicker
                ariaLabel="Filter by employee"
                queryKey="active-employees"
                value={employeeId}
                onChange={setEmployeeId}
                fetchOptions={activeEmployeeOptions}
                placeholder="By employee…"
              />
            </div>
            <div className="w-56">
              <EntityPicker
                ariaLabel="Filter by position"
                queryKey="positions"
                value={positionId}
                onChange={setPositionId}
                fetchOptions={positionOptions}
                placeholder="By position…"
              />
            </div>
            <Button
              variant={includeRecommended ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={includeRecommended}
              onClick={() => setIncludeRecommended(!includeRecommended)}
            >
              Include recommended
            </Button>
          </div>
        }
      />

      {chosen && (
        <StatGrid>
          <StatCard label="Gaps" value={rows.length} />
          <StatCard label="Mandatory" value={mandatory} tone={mandatory > 0 ? 'red' : 'green'} />
          <StatCard label="Recommended" value={rows.length - mandatory} />
        </StatGrid>
      )}

      {/* The API refuses an unbounded sweep, so this is a prompt rather than an empty table — an empty
          table here would claim there are no gaps anywhere. */}
      {!chosen ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
          <AlertTriangle className="h-6 w-6 text-fg-subtle" strokeWidth={1.5} />
          <p className="text-sm text-fg-muted">
            Choose an employee or a position to see what training is missing.
          </p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          isLoading={gaps.isLoading}
          isError={gaps.isError}
          errorMessage="Failed to load the gap report."
          emptyMessage="No gaps — every required course is current"
          emptyIcon={ShieldCheck}
        />
      )}
    </div>
  );
}

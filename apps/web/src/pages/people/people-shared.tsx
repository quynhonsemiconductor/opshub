import { useState } from 'react';
import { api } from '@/shared/api/client';
import { Select, StatusBadge, humanizeStatus, statusTone } from '@/shared/ui';
import { EMPLOYEE_STATUSES, type EmployeeResponse } from './people.types';

/**
 * The pieces the people screen's modules share.
 *
 * NO STATUS→CLASS MAP. `active`/`on_leave`/`offboarded` are in the shared `LIFECYCLE_TONE`, so
 * `statusTone` answers for them and this screen stops choosing its own greens and ambers.
 */

/** Initials circle. Kept local: the only other avatar in the SPA is the sidebar's own. */
export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-muted text-xs font-semibold text-accent-muted-fg">
      {initials}
    </div>
  );
}

/** A group name as a chip. Groups are governed on Settings → Access Control, never edited here. */
export function GroupChip({ group }: { group: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted">
      {group}
    </span>
  );
}

export function EmployeeStatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={statusTone(status)}>{humanizeStatus(status)}</StatusBadge>;
}

/**
 * Change an employee's status inline.
 *
 * A real `Select` now, rather than a `<select>` wearing the badge's colours: the coloured control was
 * indistinguishable from the read-only badge two columns away, so it read as decoration rather than
 * as something you could change. The badge shows the state; this changes it.
 */
export function StatusSelect({
  employee,
  onSuccess,
}: {
  employee: EmployeeResponse;
  onSuccess: () => void;
}) {
  const [loading, setLoading] = useState(false);

  return (
    <Select
      value={employee.status}
      disabled={loading}
      aria-label={`Status for ${employee.displayName}`}
      className="h-7 py-0 text-xs"
      onChange={async (e) => {
        setLoading(true);
        await api.PATCH('/v1/employees/{id}/status', {
          params: { path: { id: employee.id } },
          body: { status: e.target.value as (typeof EMPLOYEE_STATUSES)[number] },
        });
        setLoading(false);
        onSuccess();
      }}
    >
      {EMPLOYEE_STATUSES.map((s) => (
        <option key={s} value={s}>
          {humanizeStatus(s)}
        </option>
      ))}
    </Select>
  );
}

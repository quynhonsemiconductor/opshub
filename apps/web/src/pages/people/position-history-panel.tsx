import { useQuery } from '@tanstack/react-query';
import { Briefcase } from 'lucide-react';
import { api } from '@/shared/api/client';
import { Badge, humanizeStatus } from '@/shared/ui';
import { formatDate } from '@/shared/lib/format';
import type { EmployeePositionHistory } from '@/shared/api/types';

/**
 * The positions one employee has held, newest first.
 *
 * WHY IT IS HERE AND NOT ON THE CONTRACTS SCREEN. `employees.job_title` is free text on the person; the
 * POSITION is the seat in the org structure, and they answer different questions — "what do they call
 * themselves" versus "which approved headcount do they occupy". The contracts register already shows
 * employment history from its own route; this is the org-structure half, and `/positions/employees/{id}/history`
 * had no caller at all.
 *
 * THE ROWS NAME THE ROLE. Both history routes resolve the position's code and title server-side, because the
 * self-scoped `/positions/me` shares this query and its caller holds no `role.read` to look one up. So
 * this panel renders a title rather than the UUID it used to be handed.
 */
export function EmployeePositionHistoryPanel({ employeeId }: { employeeId: string }) {
  const history = useQuery<EmployeePositionHistory[]>({
    queryKey: ['positions', 'history', employeeId],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/positions/employees/{employeeId}/history', {
        params: { path: { employeeId } },
      });
      if (error || !data) throw new Error('Failed to load the position history');
      return data;
    },
  });
  const rows = history.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      {history.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {history.isError && (
        <p className="text-xs text-danger">Failed to load the position history.</p>
      )}
      {!history.isLoading && !history.isError && rows.length === 0 && (
        // An onboarding gap rather than an error: somebody on the register occupying no approved seat is
        // exactly what the headcount reports are about.
        <p className="text-xs text-fg-subtle">No position on record</p>
      )}

      {rows.map((role) => (
        <div
          key={role.id}
          className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <Briefcase
            className="h-4 w-4 shrink-0 text-fg-subtle"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-fg">{role.positionTitle}</p>
            <p className="truncate font-mono text-xs text-fg-subtle">{role.positionCode}</p>
          </div>
          <span className="shrink-0 text-xs text-fg-subtle">
            {formatDate(role.effectiveFrom)} —{' '}
            {role.effectiveTo ? formatDate(role.effectiveTo) : 'now'}
          </span>
          {/* Only a closed row has one, and it separates a promotion from a departure. */}
          {role.endReason && <Badge>{humanizeStatus(role.endReason)}</Badge>}
        </div>
      ))}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Briefcase, FileText } from 'lucide-react';
import { api } from '@/shared/api/client';
import { Badge, PanelState, StatusBadge, humanizeStatus, statusTone } from '@/shared/ui';
import { formatDate } from '@/shared/lib/format';
import type { ContractResponse, EmployeeRoleHistory } from '@/shared/api/types';

/**
 * What the reader's own employment record says — their roles over time, and their contracts.
 *
 * BOTH ROUTES ARE `@SelfScoped` AND NEITHER HAD A CALLER. `/v1/roles/me` and `/v1/contracts/me` take no
 * id and need no permission, so they answer a question every employee is entitled to ask about themselves —
 * and the product could not answer it anywhere. Reading it through the people or contracts registers instead
 * needs `employee.read` / `contract.read`, which a plain employee does not hold.
 *
 * NEWEST FIRST, decided by the API in both cases. Nothing here re-sorts: "what am I now" is the first line,
 * and the rest is how it got there.
 *
 * CONTENT ONLY, wrapped in `SectionCard` by the page. That card is the profile screen's own layout
 * primitive; importing it back from the page would be a cycle, and moving it here would drag four other
 * sections along for one caller.
 */

export function MyRoleHistory() {
  const roles = useQuery<EmployeeRoleHistory[]>({
    queryKey: ['roles', 'me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/roles/me');
      if (error || !data) throw new Error('Failed to load your role history');
      return data;
    },
  });
  const rows = roles.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      {roles.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {roles.isError && <p className="text-xs text-danger">Failed to load your role history.</p>}
      {!roles.isLoading && !roles.isError && rows.length === 0 && (
        // Named as the state it is. An employee with no role on record is an onboarding gap, not an
        // error, and the org chart is what it feeds.
        <p className="text-xs text-fg-subtle">No role on record yet</p>
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
            {/* The TITLE, not the id. `/roles/me` resolves it server-side precisely because a
                self-scoped caller cannot look a role up. */}
            <p className="truncate text-xs font-medium text-fg">{role.roleTitle}</p>
            <p className="truncate font-mono text-xs text-fg-subtle">{role.roleCode}</p>
          </div>
          <span className="shrink-0 text-xs text-fg-subtle">
            {formatDate(role.effectiveFrom)} —{' '}
            {role.effectiveTo ? formatDate(role.effectiveTo) : 'now'}
          </span>
          {/* Only a CLOSED row has a reason, and it is the difference between a promotion and a departure. */}
          {role.endReason && <Badge>{humanizeStatus(role.endReason)}</Badge>}
        </div>
      ))}
    </div>
  );
}

export function MyContracts() {
  const contracts = useQuery<ContractResponse[]>({
    queryKey: ['contracts', 'me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/contracts/me');
      if (error || !data) throw new Error('Failed to load your contracts');
      return data;
    },
  });
  const rows = contracts.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      <PanelState
        query={contracts}
        count={rows.length}
        empty="No contract on record yet"
        error="Failed to load your contracts."
      />

      {rows.map((contract) => (
        <div key={contract.id} className="rounded-md border border-border bg-surface px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={1.75} />
            <span className="truncate font-mono text-xs font-medium text-fg">
              {contract.reference}
            </span>
            <StatusBadge tone={statusTone(contract.status)}>
              {humanizeStatus(contract.status)}
            </StatusBadge>
            <Badge>{humanizeStatus(contract.contractType)}</Badge>
          </div>
          <p className="mt-1 text-xs text-fg-muted">
            {formatDate(contract.startDate)} —{' '}
            {contract.endDate ? formatDate(contract.endDate) : 'open-ended'}
            {/* The notice period is the number somebody actually looks this up for. */}
            {` · ${contract.noticePeriodDays} days notice`}
          </p>
          {contract.probationEndDate && (
            <p className="mt-0.5 text-xs text-fg-subtle">
              Probation ends {formatDate(contract.probationEndDate)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

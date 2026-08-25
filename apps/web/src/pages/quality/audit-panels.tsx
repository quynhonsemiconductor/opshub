import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldAlert, UserMinus } from 'lucide-react';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
import { formatDate, orDash } from '@/shared/lib/format';
import { usePermissions } from '@/shared/hooks/use-permissions';
import {
  Badge,
  EntityPicker,
  PanelAction,
  Select,
  StatusBadge,
  humanizeStatus,
  statusTone,
} from '@/shared/ui';
import { AUDIT_ROLES, type InternalAudit } from './audit.types';
import { useAuditFindings, useAuditors } from './use-audits';

/**
 * The two things an audit's drawer has to answer: who did it, and what it found.
 */

/**
 * The roster.
 *
 * WHAT IT IS FOR, and it is not attendance. The roster is what the impartiality rule reads: anybody on it
 * audited this engagement, so `CapaService` will refuse to let them certify that a corrective action for one
 * of its findings worked (`CAPA_AUDITOR_IMPARTIALITY`, ISO 9001 §9.2.2(c)). Adding somebody here therefore
 * takes a decision away from them later, which is why the panel says so rather than reading as a team list.
 *
 * AN EMPTY ROSTER BLOCKS FIELDWORK — a count over another table, so the service holds it and the register
 * offers Start only once somebody is on it. Stated here, where the fix is.
 */
export function AuditRosterPanel({ audit }: { audit: InternalAudit }) {
  const auditors = useAuditors(audit.id);
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [auditorId, setAuditorId] = useState('');
  const [role, setRole] = useState<(typeof AUDIT_ROLES)[number]>('auditor');

  const rows = auditors.data ?? [];
  const canManage = can('internal_audit.manage');
  // A settled audit accepts no roster change: the row and its findings are the §9.2.2(f) evidence.
  const settled = audit.status === 'closed' || audit.status === 'cancelled';

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['quality'] });
  }

  const assign = useMutation({
    mutationFn: async () => {
      const { error } = await api.PUT('/v1/internal-audits/{id}/auditors/{auditorId}', {
        params: { path: { id: audit.id, auditorId } },
        body: { role },
      });
      if (error) throw new Error(apiErrorMessage(error, 'Failed to assign the auditor.'));
    },
    onSuccess: () => {
      toast.success('Auditor assigned');
      setAuditorId('');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/v1/internal-audits/{id}/auditors/{auditorId}', {
        params: { path: { id: audit.id, auditorId: id } },
      });
      if (error) throw new Error(apiErrorMessage(error, 'Failed to remove the auditor.'));
    },
    onSuccess: () => {
      toast.success('Auditor removed');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-2">
      {auditors.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {auditors.isError && <p className="text-xs text-danger">Failed to load the roster.</p>}

      {/* An empty roster is not an empty list, it is the reason fieldwork cannot start. */}
      {!auditors.isLoading && !auditors.isError && rows.length === 0 && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          Nobody is rostered, so fieldwork cannot start.
        </p>
      )}

      {rows.map((auditor) => (
        <div
          key={auditor.auditorId}
          className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <div className="min-w-0 flex-1">
            {/* The NAME. This list is the one place in the module where knowing the person matters
                most — being on it bars them from certifying a fix for this audit's findings — and it
                rendered a column of uuids, so it barred somebody nobody could identify. */}
            <p className="truncate text-xs text-fg">
              {orDash(auditor.auditorName)}
              {/* The uuid stays, secondary: it is what somebody quotes in a ticket, and it is what
                  distinguishes two people who happen to share a display name. */}
              <span className="ml-2 font-mono text-2xs text-fg-subtle">{auditor.auditorId}</span>
            </p>
            <p className="text-xs text-fg-subtle">Added {formatDate(auditor.createdAt)}</p>
          </div>
          <Badge tone={auditor.role === 'lead' ? 'blue' : 'neutral'}>
            {humanizeStatus(auditor.role)}
          </Badge>
          {/* The lead cannot be dropped from the roster: the column and the roster row are one fact, and
              the service keeps them in step. Changing the lead is an edit to the audit, not a removal. */}
          {canManage && !settled && auditor.role !== 'lead' && (
            <PanelAction
              tone="danger"
              onClick={() => remove.mutate(auditor.auditorId)}
              disabled={remove.isPending}
            >
              <UserMinus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Remove
            </PanelAction>
          )}
        </div>
      ))}

      {canManage && !settled && (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border px-2.5 py-2">
          <p className="text-xs text-fg-subtle">
            Anybody added here — observers included — is barred from certifying a fix for this
            audit&apos;s findings.
          </p>
          <EntityPicker
            ariaLabel="Add an auditor"
            value={auditorId}
            onChange={(value) => setAuditorId(value)}
            queryKey="active-employees"
            fetchOptions={activeEmployeeOptions}
            placeholder="Search employees…"
          />
          <div className="flex items-center gap-2">
            <Select
              aria-label="Roster role"
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
            >
              {AUDIT_ROLES.map((code) => (
                <option key={code} value={code}>
                  {humanizeStatus(code)}
                </option>
              ))}
            </Select>
            <PanelAction
              tone="accent"
              onClick={() => assign.mutate()}
              disabled={!auditorId || assign.isPending}
            >
              Add to roster
            </PanelAction>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The findings this engagement raised.
 *
 * WHY THE COUNT IS NOT ENOUGH. An audit with ten findings and ten still open has not been followed up; one
 * with ten closed has. The register row carries both numbers for that reason, and this panel is where the
 * open ones can be read individually — worst grade first, which is the order the API returns.
 */
export function AuditFindingsPanel({ auditId }: { auditId: string }) {
  const findings = useAuditFindings(auditId);
  const rows = findings.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      {findings.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {findings.isError && <p className="text-xs text-danger">Failed to load the findings.</p>}

      {/* No findings is a legitimate result, and reads as one rather than as an error. */}
      {!findings.isLoading && !findings.isError && rows.length === 0 && (
        <p className="text-xs text-fg-subtle">No findings raised against this audit</p>
      )}

      {rows.map((finding) => (
        <div key={finding.id} className="rounded-md border border-border bg-surface px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs font-medium text-fg">{finding.reference}</span>
            <Badge tone={statusTone(finding.severity)}>{humanizeStatus(finding.severity)}</Badge>
            <StatusBadge tone={statusTone(finding.status)}>
              {humanizeStatus(finding.status)}
            </StatusBadge>
            <span className="ml-auto text-xs text-fg-subtle">{formatDate(finding.detectedAt)}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-muted">{finding.title}</p>
        </div>
      ))}
    </div>
  );
}

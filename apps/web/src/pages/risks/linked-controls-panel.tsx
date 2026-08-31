import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, ShieldCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { controlOptions } from '@/shared/api/picker-sources';
import { Badge, Button, EntityPicker, RowActions, Tooltip, humanizeStatus } from '@/shared/ui';
import { useRiskControls } from './use-risks';
import type { Risk } from './risk.types';

/**
 * The controls a risk is mitigated by.
 *
 * THIS LINK IS WHAT MAKES THE STATEMENT OF APPLICABILITY ANSWERABLE IN BOTH DIRECTIONS: which controls
 * carry this risk, and which risks justify this control. An auditor asks the second question, and a
 * control with no risk behind it is either inherited from the standard or unnecessary — which is exactly
 * what `/controls/soa/untreated-risks` reports from the other side.
 *
 * The picker offers only live controls: a retired control cannot be the answer to a current risk.
 */
export function LinkedControlsPanel({ risk, canManage }: { risk: Risk; canManage: boolean }) {
  const qc = useQueryClient();
  const controls = useRiskControls(risk.id);
  const [linking, setLinking] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['risks'] });
  const rows = controls.data ?? [];

  async function link(controlId: string) {
    const { error } = await api.PUT('/v1/risks/{id}/controls/{controlId}', {
      params: { path: { id: risk.id, controlId } },
    });
    setLinking('');
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to link the control.'));
      return;
    }
    toast.success('Control linked');
    invalidate();
  }

  async function unlink(controlId: string, title: string) {
    const { error } = await api.DELETE('/v1/risks/{id}/controls/{controlId}', {
      params: { path: { id: risk.id, controlId } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to unlink the control.'));
      return;
    }
    toast.success(`${title} unlinked`);
    invalidate();
  }

  return (
    <div className="flex flex-col gap-2">
      {controls.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {controls.isError && (
        <p className="text-xs text-danger">Failed to load the linked controls.</p>
      )}
      {!controls.isLoading && !controls.isError && rows.length === 0 && (
        // Named as the audit question it raises, rather than as an empty list.
        <p className="text-xs text-fg-subtle">
          No controls linked — nothing in the SoA currently justifies itself with this risk
        </p>
      )}

      {rows.map((control) => (
        <div
          key={control.id}
          className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <ShieldCheck className="h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-fg">{control.title}</p>
            <p className="truncate font-mono text-xs text-fg-subtle">{control.reference}</p>
          </div>
          {/* The control's SoA status, when it has an entry: a linked control that is NOT implemented is
              a risk being carried by a plan rather than by a control. */}
          {control.status && <Badge>{humanizeStatus(control.status)}</Badge>}
          {canManage && (
            <RowActions>
              <Tooltip content="Unlink">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Unlink ${control.title}`}
                  onClick={() => void unlink(control.id, control.title)}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </Button>
              </Tooltip>
            </RowActions>
          )}
        </div>
      ))}

      {canManage && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <EntityPicker
              ariaLabel="Control to link"
              queryKey="controls"
              value={linking}
              onChange={(value) => {
                setLinking(value);
                if (value) void link(value);
              }}
              fetchOptions={controlOptions}
              placeholder="Link a control…"
            />
          </div>
          <Link2
            className="h-4 w-4 shrink-0 text-fg-subtle"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );
}

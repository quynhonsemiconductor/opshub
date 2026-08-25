import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { UserMinus } from 'lucide-react';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
import { formatDate, formatMoney, orDash } from '@/shared/lib/format';
import { usePermissions } from '@/shared/hooks/use-permissions';
import {
  Badge,
  Button,
  EntityPicker,
  FormActions,
  FormError,
  FormField,
  Modal,
  PanelAction,
  PanelState,
  Textarea,
} from '@/shared/ui';
import type { LicenseUtilization, SoftwareLicense } from './use-licenses';
import { useRevokeSeat, useSeats } from './use-seats';

/**
 * Giving somebody a seat.
 *
 * TWO REFUSALS THE API OWNS. A licence with no free seats is refused (`used >= seatCount`), and an employee
 * who already holds an active seat is a conflict. The first is predictable from the utilisation report, so the
 * panel withholds the action and says why; the second is not worth pre-checking — it needs a query per
 * candidate as somebody types — so it stays the API's refusal and surfaces as its message.
 */
function AssignSeatModal({
  license,
  onClose,
  onSuccess,
}: {
  license: SoftwareLicense;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/licenses/{id}/assignments', {
        params: { path: { id: license.id } },
        body: { employeeId, notes: notes || undefined },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to assign the seat.'));
    },
    onSuccess: () => {
      toast.success('Seat assigned');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Assign a ${license.name} seat`}
      description={
        license.costPerSeatCents != null
          ? `Each seat costs ${formatMoney(license.costPerSeatCents)}, so this is a spend decision as well as an access one.`
          : 'One seat per employee. Revoking later frees the seat and keeps the record.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <FormField label="Assign to" htmlFor="seat-assignee" required>
          <EntityPicker
            id="seat-assignee"
            value={employeeId}
            onChange={(value) => setEmployeeId(value)}
            queryKey="active-employees"
            fetchOptions={activeEmployeeOptions}
            placeholder="Search employees…"
          />
        </FormField>

        <FormField
          label="Notes"
          htmlFor="seat-notes"
          hint="Why they need it, or which project pays for it."
        >
          <Textarea
            id="seat-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormField>

        <FormError message={error} />
        <FormActions loading={mutation.isPending} onClose={onClose} submitLabel="Assign seat" />
      </form>
    </Modal>
  );
}

/**
 * The seats on a licence: who holds one, who used to, and whether there is room for another.
 *
 * WHY THE UTILISATION FIGURES ARE HERE AND NOT ONLY IN THE TILES. "Assign a seat" is a decision about spend
 * and about capacity, and both are answered by the same two numbers the report already computes — so they sit
 * next to the button rather than a scroll away, and the button is withheld when there is no room.
 *
 * A LICENCE WITH NO SEAT COUNT IS UNMETERED, which is a different thing from full: the API only enforces a cap
 * when `seatCount` is set, so the panel says "unmetered" rather than showing a capacity that does not exist.
 */
export function SeatPanel({
  license,
  utilization,
}: {
  license: SoftwareLicense;
  /** The row from `/licenses/utilization`, when the report has one for this licence. */
  utilization?: LicenseUtilization;
}) {
  const { can } = usePermissions();
  const canManage = can('license.manage');
  const queryClient = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const seats = useSeats(license.id, includeRevoked);
  const revoke = useRevokeSeat();
  const rows = seats.data ?? [];

  const metered = license.seatCount != null;
  const used = utilization?.usedSeats ?? rows.filter((row) => !row.revokedAt).length;
  const available = metered ? Math.max(0, (license.seatCount ?? 0) - used) : null;
  // Predictable from the report, so the action is withheld rather than offered and refused.
  const full = metered && available === 0;

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['licenses'] });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {metered ? (
          <>
            <Badge tone={full ? 'red' : 'blue'}>
              {used} of {license.seatCount} seat(s) in use
            </Badge>
            <span className="text-xs text-fg-subtle">
              {available} free
              {license.costPerSeatCents != null &&
                ` · ${formatMoney(used * license.costPerSeatCents)} of ${formatMoney(
                  (license.seatCount ?? 0) * license.costPerSeatCents,
                )} spent`}
            </span>
          </>
        ) : (
          <>
            <Badge tone="neutral">{used} seat(s) assigned</Badge>
            {/* Unmetered is not the same as unlimited-and-free: the API enforces no cap, and that is worth
                saying rather than rendering a capacity nobody declared. */}
            <span className="text-xs text-fg-subtle">
              No seat count declared, so nothing caps how many are handed out
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant={includeRevoked ? 'primary' : 'outline'}
            size="sm"
            aria-pressed={includeRevoked}
            onClick={() => setIncludeRevoked(!includeRevoked)}
          >
            Include revoked
          </Button>
          {canManage && !full && (
            <Button variant="primary" size="sm" onClick={() => setAssigning(true)}>
              Assign a seat
            </Button>
          )}
        </span>
      </div>

      {/* Said where the button would be: a full licence needs a seat freed or the count raised, and both are
          actions somebody has to choose between. */}
      {canManage && full && (
        <p className="text-xs text-warning">
          Every seat is in use. Revoke one below, or raise the seat count on the licence, before
          assigning another.
        </p>
      )}

      <PanelState
        query={seats}
        count={rows.length}
        // Braces, not quotes. This read `empty="{…ternary…}"` — a STRING containing the source of a
        // ternary, so the panel printed `{includeRevoked ? 'No seats have ever been assigned' : …}`
        // at the user. It survived the browser spec because that literal CONTAINS the substring the
        // spec matched on, which is the hazard of asserting with a loose `getByText`.
        empty={includeRevoked ? 'No seats have ever been assigned' : 'No seats in use'}
        error="Failed to load the seats."
      />

      {rows.map((seat) => (
        // An ARTICLE named by its holder: a seat is a self-contained record, and the drawer's Details list
        // uses some of the same words ("Active"), so the rows need a name of their own to be addressable.
        <article
          key={seat.id}
          // Named by the HOLDER, so a screen reader and a test both address the row the way somebody
          // deciding whose seat to reclaim would. The id stays the fallback for a leaver whose
          // directory row has gone, because an unlabelled row is worse than an opaque one.
          aria-label={`Seat ${seat.employeeName ?? seat.employeeId}`}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {/* The NAME. Reclaiming a seat is a decision about a person — "does Mai still need
                Photoshop" — and a uuid cannot be the subject of that sentence. */}
            <span className="text-xs text-fg">{orDash(seat.employeeName)}</span>
            {seat.revokedAt ? (
              <span className="text-xs text-fg-subtle">revoked {formatDate(seat.revokedAt)}</span>
            ) : (
              <Badge tone="green">Active</Badge>
            )}
            <span className="ml-auto text-xs text-fg-subtle">
              since {formatDate(seat.assignedAt)}
            </span>
            {canManage && !seat.revokedAt && (
              <PanelAction
                tone="danger"
                onClick={() => revoke.mutate(seat.id)}
                disabled={revoke.isPending}
              >
                <UserMinus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                Revoke
              </PanelAction>
            )}
          </div>
          {seat.notes && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-fg-muted">{seat.notes}</p>
          )}
        </article>
      ))}

      {assigning && (
        <AssignSeatModal
          license={license}
          onClose={() => setAssigning(false)}
          onSuccess={refresh}
        />
      )}
    </div>
  );
}

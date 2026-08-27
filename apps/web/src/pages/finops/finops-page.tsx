import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, DollarSign, Package, PackageOpen, Plus, Users } from 'lucide-react';
import {
  Button,
  DataTable,
  EntityDetailPanel,
  ListPage,
  SlideOverSection,
  StatCard,
  StatGrid,
  StatusBadge,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { EM_DASH, formatDate, formatMoney, orDash } from '@/shared/lib/format';
import { AddLicenseModal } from './add-license-modal';
import { SeatUtilizationList, SpendByProductChart } from './finops-charts';
import { SeatPanel } from './seat-panel';
import { useLicenses, useUtilization, type SoftwareLicense } from './use-licenses';

/*
 * WHAT THIS SCREEN NO LONGER CARRIES
 *
 * Three hand-written response interfaces and raw `sessionFetch` calls, under a comment saying "until
 * openapi-typescript regenerated" — the routes had been in the generated client for a while, and the
 * hand-written `PagedResult` had already drifted: it put `total` at the top level where the API puts it
 * in `pageInfo`, so the licence count tile always read 0 and the pager, gated on `total > 0`, never
 * appeared at all. Every licence past the first fifty was unreachable.
 *
 * Also: a fourth private copy of the stat tile, a `STATUS_BADGE` class map, a `LICENSE_TYPE_LABEL` map
 * `humanizeStatus` already answers, its own `centsToDollars`, an inline search box, and the eight
 * column headers written TWICE — once for a loading skeleton and once for the real table.
 */

/** Days until a renewal, negative once it has passed. Local: nothing else counts down to one. */
function daysUntilRenewal(renewalDate: string): number {
  return Math.ceil((new Date(renewalDate).getTime() - Date.now()) / 86_400_000);
}

/** Within a month and not already expired — the window worth flagging. */
function isExpiringSoon(l: SoftwareLicense): boolean {
  if (!l.renewalDate) return false;
  return daysUntilRenewal(l.renewalDate) <= 30 && l.status !== 'expired';
}

export function FinOpsPage() {
  const qc = useQueryClient();
  /*
   * WRITING A LICENCE NEEDS `license.manage`; READING THE REGISTER NEEDS `license.read`.
   *
   * `POST /v1/licenses` carries `@RequirePermission('license.manage')`, and the nav puts this screen
   * behind `license.read` — so a finance reader, an auditor, anybody holding only the read code, saw
   * "Add license" twice and got a 403 from both. The button was not a capability, it was a trap.
   *
   * WITHHELD RATHER THAN DISABLED, and the empty state changes with it: telling somebody to "add your
   * first license" when they cannot is the same false instruction in slower words.
   */
  const canManage = usePermissions().can('license.manage');
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useListState(50);

  const licenses = useLicenses(list.search, list.limit, list.offset);
  const utilization = useUtilization();

  const rows = licenses.data?.data ?? [];
  const util = utilization.data ?? [];

  // Re-read from the page's own list, so assigning or revoking a seat moves the drawer with the row.
  const selected = selectedId ? (rows.find((l) => l.id === selectedId) ?? null) : null;
  // The report row for the open licence: `usedSeats` is the API's count, which is the number the seat cap is
  // enforced against — recomputing it here would be a second answer to the same question.
  const selectedUtil = selectedId ? util.find((r) => r.licenseId === selectedId) : undefined;

  /*
   * SPEND, THE WAY AN INVOICE MEANS IT. This tile used to sum `monthlySpendCents`, which the API
   * computed as `usedSeats × unit cost` — the cost of the occupied seats — while the Monthly column in
   * the table below computed `seatCount × unit cost` from the same row. One screen, two answers, and
   * the tile was the smaller one by roughly fifteen times on the seeded register.
   *
   * Cancelled and expired licences are excluded here: the report returns every licence because the
   * utilisation table wants them, but nobody is invoiced for a cancelled subscription, and including
   * them inflated the figure the page is read for.
   */
  const live = util.filter((r) => r.status === 'active');
  const committedSpend = live.reduce((sum, r) => sum + (r.committedSpendCents ?? 0), 0);
  const assignedSpend = live.reduce((sum, r) => sum + (r.assignedSpendCents ?? 0), 0);
  /* The number the page exists for and could not show: seats paid for that nobody is sitting in. */
  const idleSpend = committedSpend - assignedSpend;
  const assignedSeats = util.reduce((sum, r) => sum + r.usedSeats, 0);
  const totalSeats = util.reduce((sum, r) => sum + (r.seatCount ?? 0), 0);
  const expiring = rows.filter(isExpiringSoon).length;

  const columns: DataTableColumn<SoftwareLicense>[] = [
    {
      key: 'name',
      header: 'Product',
      cell: (l) => <span className="font-medium text-fg">{l.name}</span>,
    },
    { key: 'vendor', header: 'Vendor', cell: (l) => l.vendor },
    {
      key: 'type',
      header: 'Type',
      cell: (l) => humanizeStatus(l.licenseType),
      hideOnMobile: true,
    },
    { key: 'seats', header: 'Seats', align: 'right', cell: (l) => orDash(l.seatCount) },
    {
      key: 'perSeat',
      header: 'Per seat',
      align: 'right',
      cell: (l) => formatMoney(l.costPerSeatCents),
      hideOnMobile: true,
    },
    {
      key: 'monthly',
      header: 'Committed',
      align: 'right',
      /*
       * Renamed from "Monthly", which was the word the tile also used for a different number. The
       * arithmetic stays here rather than being read from the utilisation report: this table pages over
       * `licenses`, the report is a separate unpaged query, and joining them per row to display two
       * multiplied columns would be a lookup to avoid a multiplication.
       */
      cell: (l) =>
        l.seatCount != null && l.costPerSeatCents != null
          ? formatMoney(l.seatCount * l.costPerSeatCents)
          : EM_DASH,
    },
    {
      key: 'renewal',
      header: 'Renewal',
      cell: (l) => {
        if (!l.renewalDate) return EM_DASH;
        const days = daysUntilRenewal(l.renewalDate);
        return (
          <span className={isExpiringSoon(l) ? 'text-warning' : undefined}>
            {formatDate(l.renewalDate)}
            {days >= 0 && days <= 30 && (
              <span className="ml-1 text-xs text-fg-subtle">({days}d)</span>
            )}
          </span>
        );
      },
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (l) => (
        <StatusBadge tone={statusTone(l.status)}>{humanizeStatus(l.status)}</StatusBadge>
      ),
    },
  ];

  return (
    <>
      <AddLicenseModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onSuccess={() => qc.invalidateQueries({ queryKey: ['licenses'] })}
      />

      <ListPage
        title="Software & License FinOps"
        description="What the organisation pays for, how much of it is actually used, and what renews soon."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Add license
            </Button>
          ) : undefined
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search product or vendor…',
        }}
        pageInfo={licenses.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="licenses"
      >
        <div className="flex flex-col gap-5">
          <StatGrid>
            <StatCard
              label="Committed monthly spend"
              value={formatMoney(committedSpend)}
              hint="Seats bought × unit cost, active licences"
              icon={DollarSign}
              tone="green"
              loading={utilization.isLoading}
            />
            <StatCard
              label="Idle spend"
              value={formatMoney(idleSpend)}
              // The actionable half of the figure beside it: what is being paid for seats nobody holds.
              hint={
                totalSeats > assignedSeats
                  ? `${totalSeats - assignedSeats} seats paid for and unassigned`
                  : 'Every seat is assigned'
              }
              icon={AlertTriangle}
              tone={idleSpend > 0 ? 'amber' : 'green'}
              alert={idleSpend > 0}
              loading={utilization.isLoading}
            />
            <StatCard
              label="Licenses tracked"
              // From `pageInfo`, which is where the API puts it — this tile read 0 for every catalogue
              // until now.
              value={licenses.data?.pageInfo?.total ?? 0}
              icon={Package}
              tone="blue"
              loading={licenses.isLoading}
            />
            <StatCard
              label="Seats assigned"
              value={`${assignedSeats} / ${totalSeats}`}
              hint={
                totalSeats > 0
                  ? `${Math.round((assignedSeats / totalSeats) * 100)}% used`
                  : undefined
              }
              icon={Users}
              tone="violet"
              loading={utilization.isLoading}
            />
            <StatCard
              label="Renewing within 30 days"
              value={expiring}
              icon={AlertTriangle}
              tone="amber"
              alert
              loading={licenses.isLoading}
            />
          </StatGrid>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SpendByProductChart rows={util} />
            <SeatUtilizationList rows={util} />
          </div>

          <DataTable
            columns={columns}
            rows={rows}
            isLoading={licenses.isLoading}
            isError={licenses.isError}
            errorMessage="Failed to load licenses."
            emptyMessage={
              list.search
                ? 'No licenses match that search'
                : canManage
                  ? 'Add your first license to start tracking seats and cost'
                  : 'No licenses tracked yet'
            }
            emptyIcon={PackageOpen}
            emptyAction={
              list.search || !canManage ? undefined : (
                <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add license
                </Button>
              )
            }
            onRowClick={(l) => setSelectedId(l.id)}
            isRowActive={(l) => l.id === selectedId}
          />
        </div>
      </ListPage>

      {/* The drawer exists for the SEATS. The tiles say how much is used in aggregate; this is where a seat is
          given to somebody or taken back, which is the only place the aggregate can be changed. */}
      <EntityDetailPanel
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        title={selected?.name ?? 'License'}
        description={selected?.vendor}
        items={
          selected
            ? [
                { label: 'Vendor', value: selected.vendor },
                { label: 'Type', value: humanizeStatus(selected.licenseType) },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                {
                  label: 'Seats',
                  // "Unmetered" rather than a dash: the API enforces a cap only when a count is set, so the
                  // absence changes what the product DOES, not just what the cell shows.
                  value: selected.seatCount != null ? String(selected.seatCount) : 'Unmetered',
                },
                { label: 'Per seat', value: formatMoney(selected.costPerSeatCents) },
                {
                  label: 'Committed monthly',
                  value:
                    selected.seatCount != null && selected.costPerSeatCents != null
                      ? formatMoney(selected.seatCount * selected.costPerSeatCents)
                      : EM_DASH,
                },
                { label: 'Renewal', value: formatDate(selected.renewalDate) },
                ...(selected.notes ? [{ label: 'Notes', wide: true, value: selected.notes }] : []),
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'software_license' } : undefined
        }
      >
        {selected && (
          <SlideOverSection title="Seats">
            <SeatPanel license={selected} utilization={selectedUtil} />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}

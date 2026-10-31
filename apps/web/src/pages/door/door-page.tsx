import { useState } from 'react';
import { DoorOpen, Plus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Button,
  ConfirmDialog,
  DataTable,
  ListPage,
  RowAction,
  RowActions,
  SegmentedControl,
  StatusBadge,
  TabPanel,
  Tabs,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
  type SegmentedOption,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, formatDateTime, orDash } from '@/shared/lib/format';
import {
  AddCardModal,
  AssignUnknownCardModal,
  CardEditModal,
  RegisterTerminalModal,
  RegenerateTokenModal,
} from './door-modals';
import { CARD_STATUS_FILTERS } from './door.types';
import type { DoorCard, DoorTerminal, UnknownCardGroup } from './door.types';
import { useCards, useTerminals, useUnknownCards, useDoorWrites } from './use-door';

/**
 * The door: who may come in (cards), which controller watches it (terminals), and which UIDs the
 * readers saw that belong to nobody (the enrolment list).
 *
 * THE PAGE MIRRORS THE PERMISSION SPLIT. Reads need `door.read`; every write needs `door.manage` —
 * HR and IT admins both hold the manage code on purpose (one door, one code; the audit log tells
 * the two kinds of work apart), so the UI gates per action rather than per person.
 */

/** Mirrors DOOR_LOW_BATTERY_MV's server default — the alert, not the badge, is authoritative. */
const LOW_BATTERY_MV_FALLBACK = 5000;

const STATUS_FILTERS: SegmentedOption<string>[] = [
  { value: '', label: 'All' },
  ...CARD_STATUS_FILTERS.map((s) => ({ value: s, label: humanizeStatus(s) })),
];

function terminalStatus(t: DoorTerminal): 'active' | 'revoked' {
  return t.revokedAt ? 'revoked' : 'active';
}

export function DoorPage() {
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('door.manage');

  const [tab, setTab] = useState<'cards' | 'terminals' | 'unknown'>('cards');
  const [statusFilter, setStatusFilter] = useState('');
  const [registering, setRegistering] = useState(false);
  const [addingCard, setAddingCard] = useState(false);
  const [assigning, setAssigning] = useState<UnknownCardGroup | null>(null);
  const [editing, setEditing] = useState<DoorCard | null>(null);
  const [revokingCard, setRevokingCard] = useState<DoorCard | null>(null);
  const [rotating, setRotating] = useState<DoorTerminal | null>(null);
  const [revoking, setRevoking] = useState<DoorTerminal | null>(null);
  const [lostConfirming, setLostConfirming] = useState<DoorCard | null>(null);

  const terminals = useTerminals();
  const cards = useCards(statusFilter, list.limit, list.offset);
  const unknown = useUnknownCards();
  const { revokeTerminal, updateCard } = useDoorWrites();

  async function markLost() {
    if (!lostConfirming) return;
    try {
      await updateCard(lostConfirming.id, { status: 'lost' });
      toast.success('Card marked lost');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to mark the card lost.'));
    } finally {
      setLostConfirming(null);
    }
  }

  async function revoke() {
    if (!revoking) return;
    try {
      await revokeTerminal(revoking.id);
      toast.success('Terminal revoked');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to revoke the terminal.'));
    } finally {
      setRevoking(null);
    }
  }

  const terminalColumns: DataTableColumn<DoorTerminal>[] = [
    {
      key: 'name',
      header: 'Terminal',
      cell: (t) => <span className="text-sm font-medium text-fg">{t.name}</span>,
    },
    { key: 'location', header: 'Location', cell: (t) => orDash(t.location), hideOnMobile: true },
    {
      key: 'lastSeenAt',
      header: 'Last seen',
      cell: (t) => (t.lastSeenAt ? formatDateTime(t.lastSeenAt) : 'never'),
    },
    {
      key: 'droppedEvents',
      header: 'Dropped events',
      align: 'right',
      cell: (t) => <span className="tabular-nums">{t.droppedEvents}</span>,
      hideOnMobile: true,
    },
    {
      key: 'battery',
      header: 'Battery',
      cell: (t) => {
        // An implausible reading never reaches the badge (the server ignores it); it shows here
        // instead, with the value, so a miswired divider is visible without hiding real events.
        const warning = t.warnings?.find((w) => w.code === 'battery_reading_implausible');
        const battery = t.battery;
        const never = !battery || (battery.mv === null && !battery.low);
        if (never && !warning) return orDash('never reported');
        const low =
          battery !== undefined &&
          (battery.low || (battery.mv !== null && battery.mv < LOW_BATTERY_MV_FALLBACK));
        return (
          <div className="flex flex-col items-start gap-1">
            {never ? null : (
              <StatusBadge tone={low ? 'red' : 'green'}>
                {battery?.mv != null ? `${(battery.mv / 1000).toFixed(2)} V` : 'reported'}
                {low ? ' · low' : ''}
              </StatusBadge>
            )}
            {warning ? (
              <StatusBadge tone="amber">
                implausible {(warning.value / 1000).toFixed(2)} V — ignored
              </StatusBadge>
            ) : null}
          </div>
        );
      },
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => (
        <StatusBadge tone={statusTone(terminalStatus(t))}>
          {humanizeStatus(terminalStatus(t))}
        </StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (t) =>
        canManage && !t.revokedAt ? (
          <RowActions>
            <RowAction onClick={() => setRotating(t)}>Regenerate token</RowAction>
            <RowAction tone="danger" onClick={() => setRevoking(t)}>
              Revoke
            </RowAction>
          </RowActions>
        ) : null,
    },
  ];

  const cardColumns: DataTableColumn<DoorCard>[] = [
    {
      key: 'uid',
      header: 'UID',
      cell: (c) => <span className="font-mono text-xs text-fg">{c.uid}</span>,
    },
    {
      key: 'employee',
      header: 'Employee',
      cell: (c) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{c.employeeName ?? orDash(null)}</p>
          <p className="truncate text-xs text-fg-subtle">{c.label ?? orDash(null)}</p>
        </div>
      ),
    },
    {
      key: 'window',
      header: 'Valid until',
      cell: (c) => (c.validUntil ? formatDate(c.validUntil) : 'no expiry'),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (c) => (
        <StatusBadge tone={statusTone(c.status)}>{humanizeStatus(c.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (c) =>
        canManage && c.status === 'active' ? (
          <RowActions>
            <RowAction onClick={() => setEditing(c)}>Edit</RowAction>
            <RowAction tone="danger" onClick={() => setRevokingCard(c)}>
              Revoke
            </RowAction>
            <RowAction tone="danger" onClick={() => setLostConfirming(c)}>
              Mark lost
            </RowAction>
          </RowActions>
        ) : null,
    },
  ];

  const unknownColumns: DataTableColumn<UnknownCardGroup>[] = [
    {
      key: 'uid',
      header: 'UID',
      cell: (e) => <span className="font-mono text-xs text-fg">{e.uid}</span>,
    },
    { key: 'reader', header: 'Reader', cell: (e) => humanizeStatus(e.reader), hideOnMobile: true },
    {
      key: 'count',
      header: 'Swipes',
      align: 'right',
      cell: (e) => <span className="tabular-nums">{e.count}</span>,
      hideOnMobile: true,
    },
    { key: 'lastSeenAt', header: 'Last seen', cell: (e) => formatDateTime(e.lastSeenAt) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (e) =>
        canManage ? (
          <RowActions>
            <RowAction onClick={() => setAssigning(e)}>
              <UserPlus className="size-3.5" /> Enrol
            </RowAction>
          </RowActions>
        ) : null,
    },
  ];

  return (
    <ListPage
      title="Door"
      description="The RFID door and attendance terminal — cards, the controller, and UIDs waiting to be enrolled."
      actions={
        canManage ? (
          <>
            <Button onClick={() => setAddingCard(true)}>
              <Plus className="size-4" /> Enrol card
            </Button>
            <Button variant="outline" onClick={() => setRegistering(true)}>
              <DoorOpen className="size-4" /> Register terminal
            </Button>
          </>
        ) : undefined
      }
      pageInfo={tab === 'cards' ? cards.data?.pageInfo : undefined}
      onOffsetChange={list.goToOffset}
      noun="cards"
    >
      <Tabs
        value={tab}
        idPrefix="door"
        onChange={setTab}
        items={[
          { value: 'cards', label: `Cards (${cards.data?.pageInfo?.total ?? 0})` },
          { value: 'terminals', label: `Terminals (${terminals.data?.length ?? 0})` },
          { value: 'unknown', label: `Unknown (${unknown.data?.length ?? 0})` },
        ]}
      />
      {/* One panel mounted at a time — each tab fires its own query. */}
      <TabPanel idPrefix="door" value={tab}>
        {tab === 'cards' && (
          <div className="space-y-3">
            <SegmentedControl
              label="Filter by card status"
              options={STATUS_FILTERS}
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v);
                list.resetPaging();
              }}
            />
            <DataTable
              columns={cardColumns}
              rows={cards.data?.data ?? []}
              isLoading={cards.isLoading}
              emptyMessage={
                cards.data?.pageInfo?.total === 0 ? 'No cards enrolled yet.' : undefined
              }
            />
          </div>
        )}
        {tab === 'terminals' && (
          <DataTable
            columns={terminalColumns}
            rows={terminals.data ?? []}
            isLoading={terminals.isLoading}
            emptyMessage={terminals.data?.length === 0 ? 'No terminals registered.' : undefined}
          />
        )}
        {tab === 'unknown' && (
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">
              UIDs the readers saw in the last 24 hours that belonged to nobody at the time. Tap a
              new card on a reader, then enrol it here.
            </p>
            <DataTable
              columns={unknownColumns}
              rows={unknown.data ?? []}
              isLoading={unknown.isLoading}
              emptyMessage={
                unknown.data?.length === 0 ? 'Nothing unknown in the last 24 hours.' : undefined
              }
            />
          </div>
        )}
      </TabPanel>

      <RegisterTerminalModal open={registering} onClose={() => setRegistering(false)} />
      <AddCardModal open={addingCard} onClose={() => setAddingCard(false)} />
      <AssignUnknownCardModal event={assigning} onClose={() => setAssigning(null)} />
      <RegenerateTokenModal terminal={rotating} onClose={() => setRotating(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onCancel={() => setRevoking(null)}
        onConfirm={() => void revoke()}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description="The terminal can no longer authenticate. The door keeps opening from its cached allow-list."
        confirmLabel="Revoke"
      />
      <ConfirmDialog
        open={revokingCard !== null}
        onCancel={() => setRevokingCard(null)}
        onConfirm={async () => {
          if (!revokingCard) return;
          try {
            await updateCard(revokingCard.id, { status: 'revoked' });
            toast.success('Card revoked');
          } catch (err) {
            toast.error(apiErrorMessage(err, 'Failed to revoke the card.'));
          } finally {
            setRevokingCard(null);
          }
        }}
        title={`Revoke card ${revokingCard?.uid ?? ''}?`}
        description="It leaves the allow-list at the terminal's next sync. The UID can be reissued afterwards."
        confirmLabel="Revoke"
      />
      <CardEditModal key={editing?.id ?? 'none'} card={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={lostConfirming !== null}
        onCancel={() => setLostConfirming(null)}
        onConfirm={() => void markLost()}
        title={`Mark card ${lostConfirming?.uid ?? ''} lost?`}
        description="It leaves the allow-list at the terminal's next sync. Reissue a new card for the employee."
        confirmLabel="Mark lost"
      />
    </ListPage>
  );
}

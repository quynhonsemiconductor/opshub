import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  ActivityTimeline,
  DataTable,
  DescriptionList,
  PageHeader,
  PaginationFooter,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  SlideOver,
  SlideOverSection,
  StatusBadge,
  TabPanel,
  Tabs,
  UpgradeGate,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import { FEATURES } from '@/shared/config/features';
import { ShadowItPanel } from './shadow-it-tab';
import { ResolveModal } from './compliance-modals';
import { SoftwareCatalogTab } from './software-catalog-tab';
import type { FindingResponse, FindingSeverity } from '@/shared/api/types';

/*
 * NO LOCAL COLOUR MAPS.
 *
 * This file used to carry four: `LISTING_CLASS`, `SEVERITY_CLASS`, `FINDING_STATUS_CLASS` and
 * `FINDING_STATUS_LABEL`. `high` severity was `bg-orange-50 text-orange-700` — a raw palette pair in a
 * codebase built on semantic tokens, so it did not flip in dark mode and was unreadable there. The
 * shared `statusTone` decides which tone a word means, `StatusBadge` decides what a tone looks like,
 * and `humanizeStatus` turns `risk_accepted` into `Risk accepted`.
 *
 * `listing` is the ONE vocabulary that stays local: whitelisted/blacklisted/unknown/review appears on
 * this screen alone, and a lookup nobody can attribute to a caller is worse than a local one. It now lives
 * in `software-catalog-tab.tsx`, with its only caller.
 */

// ── Findings tab ──────────────────────────────────────────────────────────────

const SEVERITY_FILTERS = [
  { value: '' as const, label: 'All' },
  { value: 'critical' as const, label: 'Critical' },
  { value: 'high' as const, label: 'High' },
  { value: 'medium' as const, label: 'Medium' },
  { value: 'low' as const, label: 'Low' },
];

/**
 * The findings columns.
 *
 * A function rather than a constant because two of them need the row actions, and those close over
 * the tab's handlers. Declared outside the component so the array is not rebuilt per render.
 *
 * `canManage` is a parameter and not something the cell asks for, because a column list built outside a
 * component cannot call a hook — the tab reads the permission once and hands the answer down.
 */
function findingColumns(
  canManage: boolean,
  actions: {
    onAcknowledge: (id: string) => void;
    onResolve: (id: string) => void;
  },
): DataTableColumn<FindingResponse>[] {
  return [
    {
      key: 'software',
      header: 'Software',
      cell: (f) => <span className="font-medium text-fg">{f.softwareName}</span>,
    },
    {
      key: 'version',
      header: 'Version',
      cell: (f) => (
        <span className="font-mono text-xs text-fg-muted">{orDash(f.softwareVersion)}</span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'severity',
      header: 'Severity',
      cell: (f) => (
        <StatusBadge tone={statusTone(f.severity)}>{humanizeStatus(f.severity)}</StatusBadge>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (f) => (
        <StatusBadge tone={statusTone(f.status)}>{humanizeStatus(f.status)}</StatusBadge>
      ),
    },
    {
      key: 'detected',
      header: 'Detected',
      cell: (f) => <span className="text-xs text-fg-subtle">{formatDate(f.detectedAt)}</span>,
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: 'Actions',
      // Through `RowActions`, which owns the `stopPropagation` these needed: the row itself opens the
      // detail panel, so without it acknowledging a finding would also open the panel for it.
      //
      /*
       * OFFERED ONLY WHERE THE ROUTE WOULD ALLOW IT. Both of these were gated on the finding's status
       * alone, and both routes carry `@RequirePermission('compliance.manage')` — so every holder of
       * `compliance.read` (`auditor` holds exactly that) saw Acknowledge and Resolve on every finding
       * in the tenant, and every click was a permanent 403 rendered as "please try again".
       *
       * WITHHELD SILENTLY, unlike the requests screen's "Yours — a colleague decides". There, the answer
       * varies per ROW — you raised it, or you lack the step's permission — and the two lead to different
       * next actions, so the row has something to say. Here it is one tenant-wide fact about the reader,
       * identical on every row, so a note would repeat itself once per finding and tell nobody anything
       * the empty column does not. The sibling `software-catalog-tab.tsx` withholds Reclassify on the
       * same permission the same way; this page should not answer the question two ways.
       */
      cell: (f) => {
        if (!canManage) return null;
        const mayAcknowledge = f.status === 'open';
        const mayResolve = f.status === 'open' || f.status === 'acknowledged';
        // A resolved or risk-accepted finding has neither, and an empty `RowActions` is a flex row of
        // nothing — return the cell as empty rather than as a wrapper.
        if (!mayAcknowledge && !mayResolve) return null;
        return (
          <RowActions>
            {mayAcknowledge && (
              <RowAction tone="accent" onClick={() => actions.onAcknowledge(f.id)}>
                Acknowledge
              </RowAction>
            )}
            {mayResolve && (
              <RowAction tone="success" onClick={() => actions.onResolve(f.id)}>
                Resolve
              </RowAction>
            )}
          </RowActions>
        );
      },
    },
  ];
}

function FindingsTab() {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canManage = can('compliance.manage');
  const [severityFilter, setSeverityFilter] = useState<FindingSeverity | ''>('');
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<FindingResponse | null>(null);
  const list = useListState();

  const findings = useQuery({
    queryKey: ['compliance', 'findings', severityFilter, list.offset, list.limit],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/compliance/findings', {
        params: {
          query: {
            severity: (severityFilter || undefined) as never,
            limit: list.limit,
            offset: list.offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load findings');
      return data;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['compliance', 'findings'] });

  async function handleAcknowledge(id: string) {
    const { error } = await api.POST('/v1/compliance/findings/{id}/acknowledge', {
      params: { path: { id } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to acknowledge finding.'));
      return;
    }
    toast.success('Finding acknowledged');
    invalidate();
  }

  return (
    <>
      {/* Mounted only when there is an id, so the form resets between findings — `Modal` handles the
          open/closed transition and the focus restore. */}
      {resolveId && (
        <ResolveModal
          findingId={resolveId}
          open
          onClose={() => setResolveId(null)}
          onSuccess={invalidate}
        />
      )}

      <div className="flex flex-col gap-4">
        <SegmentedControl
          label="Filter by severity"
          options={SEVERITY_FILTERS}
          value={severityFilter}
          onChange={(value) => {
            setSeverityFilter(value);
            // Narrowing the set invalidates the offset: page 4 of the criticals may not exist.
            list.resetPaging();
          }}
        />

        <DataTable
          columns={findingColumns(canManage, {
            onAcknowledge: handleAcknowledge,
            onResolve: setResolveId,
          })}
          rows={findings.data?.data as FindingResponse[] | undefined}
          isLoading={findings.isLoading}
          isError={findings.isError}
          errorMessage="Failed to load findings."
          emptyMessage="No findings found"
          emptyIcon={ShieldAlert}
          onRowClick={(f) => setSelected(f)}
          isRowActive={(f) => f.id === selected?.id}
        />

        <PaginationFooter
          pageInfo={findings.data?.pageInfo}
          onOffsetChange={list.goToOffset}
          noun="findings"
        />
      </div>

      {/* Finding detail slide-over */}
      <SlideOver
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.softwareName ?? 'Finding detail'}
        description={selected ? `${selected.severity} · ${selected.status}` : undefined}
        width="lg"
        // The same two writes, so the same gate: withholding them in the table and offering them in the
        // panel the table opens would leave the 403 exactly one click further away.
        headerActions={
          selected &&
          canManage &&
          (selected.status === 'open' || selected.status === 'acknowledged') ? (
            <div className="flex items-center gap-2">
              {selected.status === 'open' && (
                <PanelAction
                  tone="accent"
                  onClick={() => {
                    handleAcknowledge(selected.id);
                    setSelected(null);
                  }}
                >
                  Acknowledge
                </PanelAction>
              )}
              <PanelAction
                tone="success"
                onClick={() => {
                  setResolveId(selected.id);
                  setSelected(null);
                }}
              >
                Resolve
              </PanelAction>
            </div>
          ) : undefined
        }
      >
        {selected && (
          <>
            <SlideOverSection title="Details">
              <DescriptionList
                items={[
                  { label: 'Software', value: selected.softwareName },
                  { label: 'Version', value: selected.softwareVersion },
                  {
                    label: 'Severity',
                    value: (
                      <StatusBadge tone={statusTone(selected.severity)}>
                        {humanizeStatus(selected.severity)}
                      </StatusBadge>
                    ),
                  },
                  {
                    label: 'Status',
                    value: (
                      <StatusBadge tone={statusTone(selected.status)}>
                        {humanizeStatus(selected.status)}
                      </StatusBadge>
                    ),
                  },
                  { label: 'Detected', value: formatDate(selected.detectedAt) },
                  {
                    label: 'Asset ID',
                    value: selected.assetId ? (
                      <span className="font-mono text-xs">{selected.assetId}</span>
                    ) : null,
                  },
                  {
                    label: 'CVE',
                    value: (selected as Record<string, unknown>).cveId ? (
                      <span className="font-mono text-xs text-danger">
                        {(selected as Record<string, unknown>).cveId as string}
                      </span>
                    ) : null,
                  },
                ]}
              />
            </SlideOverSection>

            <div className="mx-5 h-px bg-surface-muted" />

            <SlideOverSection title="Activity">
              <ActivityTimeline resourceId={selected.id} resourceType="compliance_finding" />
            </SlideOverSection>
          </>
        )}
      </SlideOver>
    </>
  );
}

/**
 * Shadow IT: the real panel when the integration is configured, the upgrade gate when it is not.
 *
 * WHY THE GATE IS NOW CONDITIONAL. It rendered unconditionally, so a tenant WITH Intune still saw a page
 * telling them to buy Intune, and the two endpoints behind it had no consumer at all. The flag decides which
 * of the two states a reader gets; it no longer decides whether the feature exists in the product.
 */
function ShadowItTab() {
  if (FEATURES.SHADOW_IT) return <ShadowItPanel />;

  return (
    <UpgradeGate
      feature="Shadow IT Detection"
      requiredLicense="Microsoft Intune / Endpoint Manager"
      description="Shadow IT detection scans managed devices for non-whitelisted software using Microsoft Intune's device inventory. Your current plan (Business Standard) does not include Intune — upgrade to Business Premium or add an Intune add-on."
      learnMoreHref="https://learn.microsoft.com/en-us/mem/intune/fundamentals/what-is-intune"
    />
  );
}

type ComplianceTab = 'software' | 'findings' | 'shadow-it';

/**
 * The tabs.
 *
 * Declared as data rather than as three copies of a `<button>`, and rendered by the shared `Tabs` —
 * which is a real `role="tablist"` with arrow-key navigation and a roving tab index. The hand-rolled
 * bar this replaces had none of that: a screen reader announced three unrelated buttons and never
 * connected them to the content below.
 */
const COMPLIANCE_TABS: { value: ComplianceTab; label: string; badge?: React.ReactNode }[] = [
  { value: 'software', label: 'Software Catalog' },
  { value: 'findings', label: 'Findings' },
  {
    value: 'shadow-it',
    label: 'Shadow IT',
    badge: FEATURES.SHADOW_IT ? undefined : (
      <span className="rounded bg-surface-muted px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-fg-muted">
        Upgrade
      </span>
    ),
  },
];

export function CompliancePage() {
  const [tab, setTab] = useState<ComplianceTab>('software');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Compliance"
        description="Software catalog, vulnerability findings, and remediation tracking."
      />

      <Tabs items={COMPLIANCE_TABS} value={tab} onChange={setTab} idPrefix="compliance" />

      {/* One panel at a time: mounting all three would fire every tab's query on load. */}
      <TabPanel idPrefix="compliance" value={tab}>
        {tab === 'software' && <SoftwareCatalogTab />}
        {tab === 'findings' && <FindingsTab />}
        {tab === 'shadow-it' && <ShadowItTab />}
      </TabPanel>
    </div>
  );
}

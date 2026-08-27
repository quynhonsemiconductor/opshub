import type { ReactNode } from 'react';
import type { AuditResourceType } from '@/shared/api/types';
import { ActivityTimeline } from './activity-timeline';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { DescriptionList, type DescriptionItem } from './description-list';
import { SlideOver, SlideOverSection } from './slide-over';

export interface EntityDetailPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** Approve/reject/cancel — the actions that belong to the record, top right. */
  headerActions?: ReactNode;
  /** The label/value pairs. `DescriptionList` renders the em dash for absent ones. */
  items: DescriptionItem[];
  /**
   * What the activity timeline asks about. Omit to leave the timeline out entirely — a record with
   * no audit trail should not show an empty "Activity" heading.
   */
  activity?: { resourceId: string; resourceType: AuditResourceType };
  /** Extra sections between the details and the activity — an upload widget, a linked list. */
  children?: ReactNode;
  width?: 'md' | 'lg';
}

/**
 * EntityDetailPanel — the record drawer: details, then anything specific, then the audit trail.
 *
 * WHY THIS EXISTS
 * ---------------
 * Six copies of the same three-part drawer: `SlideOver` → `SlideOverSection title="Details"` with a
 * label/value grid → a hairline → `SlideOverSection title="Activity"` with `ActivityTimeline`. Four of
 * them are in the workforce page alone, one per tab, and they had drifted in the way copies do — two
 * were `width="md"` and two `width="lg"`, the hairline was `mx-5 h-px bg-surface-muted` in five of them
 * and missing in the sixth, and one rendered the Activity heading for a record type with no audit
 * entries.
 *
 * The ORDER is the point, not just the markup: what this is, then what is special about it, then what
 * happened to it. Fixing that order here is what stops the seventh drawer inventing its own.
 *
 * The free-text fields (a note, a reason, a justification) belong in `items` with `wide: true` rather
 * than in a bespoke box below the grid — that is how five of the six were doing it, and it left the
 * same field styled two different ways depending on which drawer you opened.
 */
export function EntityDetailPanel({
  open,
  onClose,
  title,
  description,
  headerActions,
  items,
  activity,
  children,
  width = 'md',
}: EntityDetailPanelProps) {
  const canReadAudit = usePermissions().can('audit.read');
  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width={width}
      headerActions={headerActions}
    >
      <SlideOverSection title="Details">
        <DescriptionList items={items} />
      </SlideOverSection>

      {children && (
        <>
          <Hairline />
          {children}
        </>
      )}

      {/*
       * THE SECTION IS OMITTED, NOT FAILED, FOR A READER WHO MAY NOT SEE IT.
       *
       * `GET /v1/audit-logs` carries a class-level `@RequirePermission('audit.read')`, and three of
       * the eight seeded roles — manager, helpdesk, employee — do not hold it. This panel is mounted
       * by roughly two dozen drawers, four of which (leave, overtime, timesheets, shifts) are
       * SELF-SERVICE screens an employee holding no permissions at all is meant to use. So for those
       * readers the Activity section could only ever fail.
       *
       * `TimelineUnreadable` already stopped it LYING about that — it used to render the empty state,
       * which asserted in the product's own voice that a record had never been touched. But an honest
       * `role="alert"` on every drawer a reader opens, about a permission they will never hold and
       * cannot request, is noise that teaches people to ignore alerts. A section that is not there
       * says the same thing more quietly.
       *
       * Checked HERE and not in ~24 call sites: one place cannot be forgotten by the next drawer, and
       * the header goes with the body — a "Activity" heading over nothing is its own small lie.
       * `ActivityTimeline` keeps its error state for the case that remains real: a reader who HOLDS
       * `audit.read` and whose request failed anyway.
       */}
      {activity && canReadAudit && (
        <>
          <Hairline />
          <SlideOverSection title="Activity">
            <ActivityTimeline
              resourceId={activity.resourceId}
              resourceType={activity.resourceType}
            />
          </SlideOverSection>
        </>
      )}
    </SlideOver>
  );
}

/** The section divider, in one place rather than in each drawer's copy of it. */
function Hairline() {
  return <div className="mx-5 h-px bg-surface-muted" />;
}

import { useState } from 'react';
import { PageHeader, TabPanel, Tabs } from '@/shared/ui';
import { TimesheetsTab } from './timesheets-tab';
import { LeaveTab } from './leave-tab';
import { OvertimeTab } from './overtime-tab';
import { ShiftsTab } from './shifts-tab';
import { LeaveAdminTab } from './leave-admin-tab';
import { WioCalendarTab } from './wio-calendar-tab';

/*
 * WHAT THIS SCREEN NO LONGER CARRIES
 *
 * Three status→class maps (timesheet, leave, overtime) that assigned different colours to the same
 * words the inbox and access screens were also colouring; a LOCAL `StatusBadge` that shadowed the
 * shared one of the same name; an `inputClass` string; four hand-rolled `fixed inset-0` dialogs with no
 * `role="dialog"`, focus trap or Escape; four copies of the filter strip; four raw tables (21 header
 * cells); four Details/Activity drawers; and thirteen inline `toLocaleDateString()` calls.
 *
 * `statusTone` decides which tone a word means, `StatusBadge` what a tone looks like, `Modal` owns
 * dialog behaviour, `DataTable` owns the table's states, `EntityDetailPanel` owns the drawer, and
 * `formatDate` owns dates — including the part that matters here: `startDate` is a `date` column, so
 * `new Date('2026-03-04')` was rendering as the 3rd for anybody behind UTC.
 */

type WorkforceTab = 'timesheets' | 'wio' | 'leave' | 'balances' | 'overtime' | 'shifts';

const WORKFORCE_TABS: { value: WorkforceTab; label: string }[] = [
  { value: 'timesheets', label: 'Timesheets' },
  // Beside Timesheets: both answer "where is everyone working", this one for the days ahead.
  { value: 'wio', label: 'WIO Calendar' },
  { value: 'leave', label: 'Leave' },
  // Next to Leave, not at the end: "how many days do I have" is the question somebody asks on the way to
  // filing a request, and the two tabs read the same rows from different ends.
  { value: 'balances', label: 'Balances & calendar' },
  { value: 'overtime', label: 'Overtime' },
  { value: 'shifts', label: 'Shifts' },
];

/**
 * The workforce screen: four record types, four approval flows, one tab bar.
 *
 * COMPOSITION ONLY. Each tab lives in its own module — the single-file version reached 1272 lines and
 * the FE ratchet refused it, correctly: a page that also contains four forms, four tables and four
 * drawers is not composing anything, it is four screens sharing a filename.
 */
export function WorkforcePage() {
  const [tab, setTab] = useState<WorkforceTab>('timesheets');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Workforce"
        description="Timesheets, leave, overtime and shift logs — each with its own approval flow — plus leave balances and the holiday calendar."
      />

      <Tabs items={WORKFORCE_TABS} value={tab} onChange={setTab} idPrefix="workforce" />

      {/* One panel mounted at a time: all four would fire all four queries on load. */}
      <TabPanel idPrefix="workforce" value={tab}>
        {tab === 'timesheets' && <TimesheetsTab />}
        {tab === 'wio' && <WioCalendarTab />}
        {tab === 'leave' && <LeaveTab />}
        {tab === 'balances' && <LeaveAdminTab />}
        {tab === 'overtime' && <OvertimeTab />}
        {tab === 'shifts' && <ShiftsTab />}
      </TabPanel>
    </div>
  );
}

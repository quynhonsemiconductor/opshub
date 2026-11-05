import { useState } from 'react';
import { PageHeader, TabPanel, Tabs } from '@/shared/ui';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { CoursesTab } from './courses-tab';
import { GapsTab } from './gaps-tab';
import { MyTrainingTab } from './my-training-tab';
import { RecordsTab } from './records-tab';
import { RequirementsTab } from './requirements-tab';

/**
 * Training and competency — the third module whose API had no screen at all.
 *
 * FIVE TABS, ONE OF WHICH EVERYBODY SEES. "My training" is self-scoped: the API keys it on the caller's
 * own id, so an employee holding no permission codes still reaches their own record and their own
 * outstanding courses. The other four need `training.read`, so they are not rendered for somebody who
 * would only get a 403 — a tab that exists to fail is worse than one that is absent.
 *
 * The tab ORDER puts "My training" first for anybody who cannot manage: the first tab is the one that
 * opens, and for most of the company that is the only one worth opening.
 *
 * COMROLE ONLY. Each tab is its own module for the reason workforce's four are: a page that also
 * contains three forms, five tables and a drawer is not composing anything.
 */

type TrainingTab = 'mine' | 'records' | 'courses' | 'requirements' | 'gaps';

export function TrainingPage() {
  const { can } = usePermissions();
  const canRead = can('training.read');

  const tabs: { value: TrainingTab; label: string }[] = [
    { value: 'mine', label: 'My training' },
    ...(canRead
      ? ([
          { value: 'records', label: 'Records' },
          { value: 'courses', label: 'Courses' },
          { value: 'requirements', label: 'Requirements' },
          { value: 'gaps', label: 'Competency gaps' },
        ] as const)
      : []),
  ];

  // Starts on Records for somebody who manages training and on their own record for everybody else.
  const [tab, setTab] = useState<TrainingTab>(canRead ? 'records' : 'mine');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Training"
        description="Courses, what each role requires, who has completed what, and what is missing."
      />

      <Tabs items={tabs} value={tab} onChange={setTab} idPrefix="training" />

      {/* One panel at a time: mounting all five would fire five queries, three of which nobody asked for. */}
      <TabPanel idPrefix="training" value={tab}>
        {tab === 'mine' && <MyTrainingTab />}
        {tab === 'records' && <RecordsTab />}
        {tab === 'courses' && <CoursesTab />}
        {tab === 'requirements' && <RequirementsTab />}
        {tab === 'gaps' && <GapsTab />}
      </TabPanel>
    </div>
  );
}

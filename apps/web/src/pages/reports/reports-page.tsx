import { useState } from 'react';
import { PageHeader, SegmentedControl } from '@/shared/ui';
import { DAYS_OPTIONS } from './report-config';
import { AssetUtilizationChart } from './asset-reports';
import { FindingsChart } from './compliance-reports';
import {
  CycleTimeChart,
  QueueTable,
  RequestMixChart,
  SlaChart,
  ThroughputChart,
} from './request-reports';
import { WorkforceSummary } from './workforce-reports';

/*
 * Analytics across the four systems.
 *
 * COMPOSITION ONLY: pick a window, lay the panels out. Each panel renders its own `Card` — it has to,
 * because the panel owns the query, and its export button (which lives in the card header) needs the
 * loaded rows to know whether it can be pressed at all. The charts and the panel frame moved to their
 * own modules when this file passed the FE line ceiling — which it did because of the comments
 * explaining the colour change, not because of new behaviour, and the ceiling is right either way.
 */
export function ReportsPage() {
  const [days, setDays] = useState(30);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Analytics and KPIs across IT operations, compliance and workforce."
        actions={
          // A window picker is one choice from three, which is a segmented control rather than a
          // select — and it is now announced as "Reporting window" instead of as a bare combobox.
          <SegmentedControl
            label="Reporting window"
            options={DAYS_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            value={String(days)}
            onChange={(value) => setDays(Number(value))}
          />
        }
      />

      {/* Row 1: Throughput (wide) + Queue depth */}
      <div className="grid grid-cols-3 gap-4">
        <ThroughputChart days={days} className="col-span-2" />
        <QueueTable />
      </div>

      {/* Row 2: SLA compliance + Cycle time */}
      <div className="grid grid-cols-2 gap-4">
        <SlaChart days={days} />
        <CycleTimeChart days={days} />
      </div>

      {/* What the window is made of, before the per-measure panels below break it down. */}
      <RequestMixChart days={days} />

      {/* Row 3: Asset utilization + Findings donut */}
      <div className="grid grid-cols-2 gap-4">
        <AssetUtilizationChart />
        <FindingsChart days={days} />
      </div>

      {/* Row 4: Workforce */}
      <WorkforceSummary days={days} />
    </div>
  );
}

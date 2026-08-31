/**
 * The WORKFORCE reports — `/v1/reports/workforce/*`.
 *
 * Leave and overtime read together: two queries, one panel, because "who is off and who is over" is one
 * question a manager asks at once.
 *
 * NOT A CHART, and the split made that visible: this panel is four stat tiles, so it imports no recharts and
 * no `ChartSkeleton` — it was carrying both through the shared header of the old combined file.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { STALE } from '@/shared/api/cache';
import type { LeaveSummaryResponse, OvertimeSummaryResponse } from '@/shared/api/types';
import { dateRange } from './report-config';
import { Card, ChartSkeleton, ErrorMsg } from './report-parts';

export function WorkforceSummary({ days }: { days: number }) {
  const { from, to } = dateRange(days);

  const leaveQ = useQuery<LeaveSummaryResponse>({
    queryKey: ['reports', 'leave', days],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/reports/workforce/leave', {
        params: { query: { from, to } },
      });
      if (error || !data) throw new Error();
      return data;
    },
    staleTime: STALE.REPORT,
  });

  const otQ = useQuery<OvertimeSummaryResponse>({
    queryKey: ['reports', 'overtime', days],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/reports/workforce/overtime', {
        params: { query: { from, to } },
      });
      if (error || !data) throw new Error();
      return data;
    },
    staleTime: STALE.REPORT,
  });

  /*
   * THE STATES THIS PANEL DID NOT HAVE. It rendered four bold figures unconditionally with `?? 0`, so
   * a 403 or a dropped request printed "Leave requests 0 — this period" as a confident fact. Its three
   * sibling report files each use these two components; this was the one that did not, which is why it
   * was the only panel that could report a failure as data.
   *
   * Both queries are required before any figure is shown: two tiles from a live query beside two from
   * a failed one is a panel that is half true, and there is no way for a reader to tell which half.
   */
  if (leaveQ.isLoading || otQ.isLoading) return <ChartSkeleton />;
  if (leaveQ.isError || otQ.isError || !leaveQ.data || !otQ.data) return <ErrorMsg />;

  const totalLeave = leaveQ.data.rows.reduce((s, r) => s + r.count, 0);
  const totalOTHours = otQ.data.rows.reduce((s, r) => s + r.totalHours, 0);
  const approvedOT = otQ.data.rows.find((r) => r.status === 'approved');

  return (
    /*
     * NO EXPORT BUTTON, unlike its seven siblings: four stat tiles are not a row grid, and the two
     * queries behind them (leave by type and status, overtime by status) have different shapes — there
     * is no one table this panel shows to export.
     */
    <Card title="Workforce Summary">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface-muted p-3">
          <p className="text-xs text-fg-subtle">Leave requests</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">{totalLeave}</p>
          <p className="mt-0.5 text-2xs text-fg-subtle">this period</p>
        </div>
        <div className="rounded-lg bg-surface-muted p-3">
          <p className="text-xs text-fg-subtle">Overtime hours</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">{Math.round(totalOTHours)}</p>
          <p className="mt-0.5 text-2xs text-fg-subtle">total submitted</p>
        </div>
        <div className="rounded-lg bg-surface-muted p-3">
          <p className="text-xs text-fg-subtle">Approved OT hours</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">
            {Math.round(approvedOT?.totalHours ?? 0)}
          </p>
          <p className="mt-0.5 text-2xs text-fg-subtle">
            avg {Math.round(approvedOT?.avgHours ?? 0)}h / request
          </p>
        </div>
        <div className="rounded-lg bg-surface-muted p-3">
          <p className="text-xs text-fg-subtle">Approved OT requests</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">{approvedOT?.count ?? 0}</p>
          <p className="mt-0.5 text-2xs text-fg-subtle">approved this period</p>
        </div>
      </div>
    </Card>
  );
}

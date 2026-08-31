/**
 * The REQUEST reports — everything under `/v1/reports/requests/*`.
 *
 * Split from a single `report-charts.tsx` that held all seven panels and sat exactly AT the 486-line
 * ratchet ceiling, which meant no change to any report could land until it was decomposed. The seam is the
 * API's own report families rather than a made-up grouping, so a new endpoint has an obvious home: request
 * reports here, asset reports next door, and so on.
 *
 *  - throughput   — daily submitted vs resolved (area)
 *  - SLA          — per-type compliance rate (bar)
 *  - cycle time   — p50 / p90 hours per type (bar)
 *  - queue depth  — current pending / in-review (table)
 *  - the mix      — counts by type and status (stacked bar + table)
 */
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { api } from '@/shared/api/client';
import { POLL, STALE } from '@/shared/api/cache';
import type {
  ThroughputResponse,
  SlaComplianceResponse,
  CycleTimeResponse,
  QueueDepthResponse,
  RequestSummaryResponse,
} from '@/shared/api/types';
import { Card, ChartSkeleton, ErrorMsg, ExportCsvButton } from './report-parts';
import type { CsvColumn } from './export-csv';
import {
  BLUE,
  CYCLE_TIME_CSV_COLUMNS,
  GREEN,
  QUEUE_CSV_COLUMNS,
  RED,
  REQUEST_STATUS_STACK,
  SLA_CSV_COLUMNS,
  THROUGHPUT_CSV_COLUMNS,
  VIOLET,
  buildMixGrid,
  capitalize,
  dateRange,
  shortDay,
  type MixGridRow,
} from './report-config';

export function ThroughputChart({ days, className }: { days: number; className?: string }) {
  const { from, to } = dateRange(days);
  const { data, isLoading, isError } = useQuery<ThroughputResponse>({
    queryKey: ['reports', 'throughput', days],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/reports/requests/throughput', {
        params: { query: { from, to } },
      });
      if (error || !data) throw new Error();
      return data;
    },
    staleTime: STALE.REPORT,
  });

  if (isLoading) return <ChartSkeleton />;
  if (isError || !data) return <ErrorMsg />;

  const chartData = data.points.map((p) => ({
    day: shortDay(p.day),
    submitted: p.submitted,
    resolved: p.resolved,
  }));

  return (
    <Card
      title="Request Throughput"
      className={className}
      actions={
        <ExportCsvButton
          name="Request Throughput"
          columns={THROUGHPUT_CSV_COLUMNS}
          rows={data.points}
        />
      }
    >
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="gradSubmitted" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={BLUE} stopOpacity={0.15} />
              <stop offset="95%" stopColor={BLUE} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradResolved" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={GREEN} stopOpacity={0.15} />
              <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 10, fill: '#a1a1aa' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#a1a1aa' }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e4e4e7' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area
            type="monotone"
            dataKey="submitted"
            name="Submitted"
            stroke={BLUE}
            fill="url(#gradSubmitted)"
            strokeWidth={2}
            dot={false}
          />
          <Area
            type="monotone"
            dataKey="resolved"
            name="Resolved"
            stroke={GREEN}
            fill="url(#gradResolved)"
            strokeWidth={2}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ── SLA compliance ────────────────────────────────────────────────────────────

export function SlaChart({ days }: { days: number }) {
  const { from, to } = dateRange(days);
  const { data, isLoading, isError } = useQuery<SlaComplianceResponse>({
    queryKey: ['reports', 'sla', days],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/reports/requests/sla-compliance', {
        params: { query: { from, to } },
      });
      if (error || !data) throw new Error();
      return data;
    },
    staleTime: STALE.REPORT,
  });

  if (isLoading) return <ChartSkeleton />;
  if (isError || !data) return <ErrorMsg />;

  const chartData = data.rows.map((r) => ({
    type: capitalize(r.type),
    'Within SLA': r.withinSla,
    Breached: r.breached,
    Rate: r.complianceRatePct ?? 0,
  }));

  // The empty window stays INSIDE the panel, so its export button sits disabled beside the title
  // rather than vanishing with the chart.
  const chart =
    chartData.length > 0 ? (
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
          <XAxis
            dataKey="type"
            tick={{ fontSize: 10, fill: '#a1a1aa' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#a1a1aa' }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e4e4e7' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="Within SLA" fill={GREEN} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Breached" fill={RED} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    ) : (
      <p className="py-4 text-center text-xs text-fg-subtle">No SLA data for this period</p>
    );

  return (
    <Card
      title="SLA Compliance"
      actions={<ExportCsvButton name="SLA Compliance" columns={SLA_CSV_COLUMNS} rows={data.rows} />}
    >
      {chart}
    </Card>
  );
}

// ── Cycle time ────────────────────────────────────────────────────────────────

export function CycleTimeChart({ days }: { days: number }) {
  const { from, to } = dateRange(days);
  const { data, isLoading, isError } = useQuery<CycleTimeResponse>({
    queryKey: ['reports', 'cycle-time', days],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/reports/requests/cycle-time', {
        params: { query: { from, to } },
      });
      if (error || !data) throw new Error();
      return data;
    },
    staleTime: STALE.REPORT,
  });

  if (isLoading) return <ChartSkeleton />;
  if (isError || !data) return <ErrorMsg />;

  const chartData = data.rows.map((r) => ({
    type: capitalize(r.type),
    'p50 (h)': Math.round(r.p50Hours),
    'p90 (h)': Math.round(r.p90Hours),
  }));

  const chart =
    chartData.length > 0 ? (
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
          <XAxis
            dataKey="type"
            tick={{ fontSize: 10, fill: '#a1a1aa' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#a1a1aa' }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e4e4e7' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="p50 (h)" fill={BLUE} radius={[3, 3, 0, 0]} />
          <Bar dataKey="p90 (h)" fill={VIOLET} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    ) : (
      <p className="py-4 text-center text-xs text-fg-subtle">No cycle time data for this period</p>
    );

  return (
    <Card
      title="Cycle Time (p50 / p90)"
      actions={
        <ExportCsvButton
          name="Cycle Time (p50 / p90)"
          columns={CYCLE_TIME_CSV_COLUMNS}
          rows={data.rows}
        />
      }
    >
      {chart}
    </Card>
  );
}

// ── Queue depth ───────────────────────────────────────────────────────────────

export function QueueTable() {
  const { data, isLoading, isError } = useQuery<QueueDepthResponse>({
    queryKey: ['reports', 'queue'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/reports/requests/queue');
      if (error || !data) throw new Error();
      return data;
    },
    staleTime: STALE.ACTIVITY,
    refetchInterval: POLL.ACTIVITY,
  });

  if (isLoading) return <div className="h-24 animate-pulse rounded-lg bg-surface-muted" />;
  if (isError || !data) return <ErrorMsg />;

  return (
    <Card
      title="Live Queue Depth"
      actions={
        <ExportCsvButton name="Live Queue Depth" columns={QUEUE_CSV_COLUMNS} rows={data.rows} />
      }
    >
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="pb-2 text-left font-medium text-fg-muted">Type</th>
            <th className="pb-2 text-right font-medium text-fg-muted">Pending</th>
            <th className="pb-2 text-right font-medium text-fg-muted">In Review</th>
            <th className="pb-2 text-right font-medium text-warning">At Risk</th>
            <th className="pb-2 text-right font-medium text-fg-muted">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.rows.map((r) => (
            <tr key={r.type}>
              <td className="py-2 text-fg-muted">{capitalize(r.type)}</td>
              <td className="py-2 text-right tabular-nums text-fg-muted">{r.pending}</td>
              <td className="py-2 text-right tabular-nums text-fg-muted">{r.inReview}</td>
              <td
                className={`py-2 text-right tabular-nums font-medium ${r.atRisk > 0 ? 'text-warning' : 'text-fg-subtle'}`}
              >
                {r.atRisk}
              </td>
              <td className="py-2 text-right tabular-nums font-semibold text-fg">{r.total}</td>
            </tr>
          ))}
          {data.rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-fg-subtle">
                Queue is empty
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

// ── The mix ───────────────────────────────────────────────────────────────────

/**
 * Request counts by TYPE and STATUS — what the queue is made of.
 *
 * WHY A STACKED BAR AND NOT ANOTHER LINE. The other three request panels are all about time: how many per
 * day, how often the SLA was met, how long things took. None answers "what is in here" — a cross-tab of
 * type against status is a composition, and the bar's total is a number somebody wants as much as its parts.
 *
 * A TABLE SITS UNDER IT, and not as an afterthought. Two segments in this stack can be small enough to be
 * unclickable, the neutral one is under 3:1 against the surface, and identity in a chart must never rest on
 * colour alone — so the exact grid is readable as text, and it also keeps `cancelled` and `expired` distinct
 * where the chart folds them together.
 *
 * The 2px surface-coloured stroke between segments is a spacer, not a border: touching fills of similar
 * lightness merge into one block, and the gap is what makes five segments countable.
 */
export function RequestMixChart({ days }: { days: number }) {
  const { from, to } = dateRange(days);
  const { data, isLoading, isError } = useQuery<RequestSummaryResponse>({
    queryKey: ['reports', 'request-summary', days],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/reports/requests/summary', {
        params: { query: { from, to } },
      });
      if (error || !data) throw new Error();
      return data;
    },
    staleTime: STALE.REPORT,
  });

  if (isLoading) return <ChartSkeleton />;
  if (isError || !data) return <ErrorMsg />;

  const { statuses, chartRows, tableRows } = buildMixGrid(data.rows);

  // One column per raw status — the CSV is the grid the table shows, where `cancelled` and `expired`
  // stay separable, unlike the stack above them.
  const exportColumns: CsvColumn<MixGridRow>[] = [
    { header: 'Type', value: (r) => r.type },
    ...statuses.map((status, i) => ({
      header: capitalize(status),
      value: (r: MixGridRow) => r.cells[i],
    })),
    { header: 'Total', value: (r) => r.total },
  ];

  /*
   * A BLOCK wrapper, not `flex flex-col`. `ResponsiveContainer width="100%"` measures its parent, and
   * inside a flex column it resolved to zero — so the chart silently drew nothing while the table beside it
   * rendered fine. Measured in a real browser; jsdom cannot see it, and the panel looked complete because
   * the table carried the numbers. The other charts on this page return the container as their root and
   * never hit it.
   *
   * An empty window stays INSIDE the panel — the export button sits disabled beside the title rather than
   * vanishing with the content.
   */
  const body =
    data.rows.length > 0 ? (
      <div className="space-y-4">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartRows} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis dataKey="type" tick={{ fontSize: 11 }} stroke="var(--color-fg-subtle)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-fg-subtle)" allowDecimals={false} />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                borderRadius: 8,
                border: '1px solid var(--color-border)',
              }}
            />
            {/* Present because there is more than one series — identity is never colour alone. */}
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {REQUEST_STATUS_STACK.map((segment, i) => (
              <Bar
                key={segment.key}
                dataKey={segment.key}
                name={segment.label}
                stackId="mix"
                fill={segment.color}
                // The spacer: a surface-coloured hairline so adjacent fills stay countable.
                stroke="var(--color-surface)"
                strokeWidth={2}
                // Only the top segment gets the rounded data-end, so the stack reads as one bar.
                radius={i === REQUEST_STATUS_STACK.length - 1 ? [4, 4, 0, 0] : undefined}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>

        {/* The same grid as text. Also the only place `cancelled` and `expired` are separable. */}
        <table className="w-full text-xs">
          <caption className="sr-only">Request counts by type and status</caption>
          <thead>
            <tr className="border-b border-border text-fg-subtle">
              <th scope="col" className="py-1.5 text-left font-medium">
                Type
              </th>
              {statuses.map((status) => (
                <th key={status} scope="col" className="py-1.5 text-right font-medium">
                  {capitalize(status)}
                </th>
              ))}
              <th scope="col" className="py-1.5 text-right font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map(({ type, cells, total }) => (
              <tr key={type} className="border-b border-border/60">
                <th scope="row" className="py-1.5 text-left font-medium text-fg">
                  {type}
                </th>
                {cells.map((count, i) => (
                  <td key={statuses[i]} className="py-1.5 text-right tabular-nums text-fg-muted">
                    {count}
                  </td>
                ))}
                <td className="py-1.5 text-right font-semibold tabular-nums text-fg">{total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p className="py-8 text-center text-xs text-fg-subtle">No requests in this window</p>
    );

  return (
    <Card
      title="Requests by Type and Status"
      actions={
        <ExportCsvButton
          name="Requests by Type and Status"
          columns={exportColumns}
          rows={tableRows}
        />
      }
    >
      {body}
    </Card>
  );
}

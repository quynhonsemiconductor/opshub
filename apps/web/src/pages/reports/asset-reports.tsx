/**
 * The ASSET reports — `/v1/reports/assets/*`.
 *
 * One panel today. Its own file rather than folded in beside the request reports, because the seam is the
 * API's report families: the next asset report lands here without anybody deciding where it goes.
 */
import { useQuery } from '@tanstack/react-query';
import {
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
import { STALE } from '@/shared/api/cache';
import type { AssetUtilizationResponse } from '@/shared/api/types';
import { Card, ChartSkeleton, ErrorMsg, ExportCsvButton } from './report-parts';
import type { CsvColumn } from './export-csv';
import { BLUE, GREEN, ZINC, capitalize } from './report-config';

export function AssetUtilizationChart() {
  const { data, isLoading, isError } = useQuery<AssetUtilizationResponse>({
    queryKey: ['reports', 'assets'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/reports/assets/utilization');
      if (error || !data) throw new Error();
      return data;
    },
    staleTime: STALE.REPORT,
  });

  if (isLoading) return <ChartSkeleton />;
  if (isError || !data) return <ErrorMsg />;

  const chartData = data.rows.map((r) => ({
    type: capitalize(r.type),
    assigned: r.assigned,
    inStock: r.inStock,
    retired: r.retired,
    pct: r.utilizationPct,
  }));

  const exportColumns: CsvColumn<AssetUtilizationResponse['rows'][number]>[] = [
    { header: 'Type', value: (r) => capitalize(r.type) },
    { header: 'Assigned', value: (r) => r.assigned },
    { header: 'In Stock', value: (r) => r.inStock },
    { header: 'Retired', value: (r) => r.retired },
    { header: 'Utilization (%)', value: (r) => r.utilizationPct },
  ];

  // The empty state stays INSIDE the panel, so its export button sits disabled beside the title
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
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e4e4e7' }}
            formatter={(val, name) => (name === 'pct' ? `${val}%` : val)}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="assigned" name="Assigned" fill={BLUE} radius={[3, 3, 0, 0]} stackId="a" />
          <Bar dataKey="inStock" name="In Stock" fill={GREEN} radius={[3, 3, 0, 0]} stackId="a" />
          <Bar dataKey="retired" name="Retired" fill={ZINC} radius={[3, 3, 0, 0]} stackId="a" />
        </BarChart>
      </ResponsiveContainer>
    ) : (
      <p className="py-4 text-center text-xs text-fg-subtle">No asset data</p>
    );

  return (
    <Card
      title="Asset Utilization"
      actions={
        <ExportCsvButton name="Asset Utilization" columns={exportColumns} rows={data.rows} />
      }
    >
      {chart}
    </Card>
  );
}

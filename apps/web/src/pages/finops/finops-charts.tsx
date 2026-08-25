import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatMoney } from '@/shared/lib/format';
import type { LicenseUtilization } from './use-licenses';

/**
 * Chart colours.
 *
 * CSS VARIABLES, not hex. The six literals this replaces (`#2563eb`, `#16a34a`, …) were the light
 * theme's palette baked into the component, so every slice kept its light-mode colour on a dark
 * background. SVG `fill` resolves `var()` like any other property, so the tokens work here exactly as
 * they do in Tailwind — and the chart now follows the theme for free.
 */
const SLICE_TONES = [
  'var(--color-info)',
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-danger)',
  'var(--color-violet-fg)',
  'var(--color-accent)',
];

/**
 * Committed spend by product, biggest six, plus the tail as one slice.
 *
 * THREE THINGS WERE WRONG WITH THE OLD VERSION and they compounded. It charted
 * `monthlySpendCents` — the cost of ASSIGNED seats — so it disagreed with the tile above it. It then
 * filtered to `> 0`, which drops a licence nobody is assigned to: the single most wasteful row in the
 * register was the one row guaranteed to be absent. And `slice(0, 6)` discarded the rest silently, so
 * the slices did not sum to the total anywhere on screen.
 *
 * Now: committed spend, active licences, and an explicit "N others" slice so the chart accounts for
 * the whole figure the tile reports.
 */
export function SpendByProductChart({ rows }: { rows: LicenseUtilization[] }) {
  const priced = rows
    .filter((r) => r.status === 'active' && (r.committedSpendCents ?? 0) > 0)
    .sort((a, b) => (b.committedSpendCents ?? 0) - (a.committedSpendCents ?? 0));
  const top = priced.slice(0, 6).map((r) => ({ name: r.name, value: r.committedSpendCents ?? 0 }));
  const tail = priced.slice(6).reduce((sum, r) => sum + (r.committedSpendCents ?? 0), 0);
  const data = tail > 0 ? [...top, { name: `${priced.length - 6} others`, value: tail }] : top;

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 text-sm font-semibold text-fg">Committed spend by product</h2>
      {data.length === 0 ? (
        <p className="text-xs text-fg-muted">No cost data yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80}>
              {data.map((_, i) => (
                <Cell key={i} fill={SLICE_TONES[i % SLICE_TONES.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(value) => formatMoney(Number(value))} />
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/**
 * Seat utilisation, worst first.
 *
 * The bar is `aria-hidden` and the figure beside it carries the number, because a bar whose only
 * output is a width tells a screen reader nothing.
 */
export function SeatUtilizationList({ rows }: { rows: LicenseUtilization[] }) {
  const withSeats = rows
    .filter((r) => r.seatCount != null && r.seatCount > 0)
    .sort((a, b) => (b.utilizationPct ?? 0) - (a.utilizationPct ?? 0))
    .slice(0, 8);

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 text-sm font-semibold text-fg">Seat utilization</h2>
      {withSeats.length === 0 ? (
        <p className="text-xs text-fg-muted">No seat-based licenses yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {withSeats.map((r) => {
            const pct = Math.min(100, Math.max(0, r.utilizationPct ?? 0));
            return (
              <li key={r.licenseId} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-fg">{r.name}</span>
                  <span className="shrink-0 tabular-nums text-fg-muted">
                    {r.usedSeats}/{r.seatCount} · {Math.round(pct)}%
                  </span>
                </div>
                <div
                  aria-hidden="true"
                  className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
                >
                  <div
                    className={
                      pct >= 90
                        ? 'h-full bg-danger'
                        : pct >= 70
                          ? 'h-full bg-warning'
                          : 'h-full bg-success'
                    }
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

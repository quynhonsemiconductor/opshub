import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import type { components } from '@/shared/api/types';
import { Shield, ShieldAlert, TrendingUp, TrendingDown, Minus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button, PageHeader, UpgradeGate, type BadgeTone } from '@/shared/ui';
import { FEATURES } from '@/shared/config/features';
import { cn } from '@/shared/lib/utils';
import { BaselinePanel } from './baseline-panel';

// ── Types ─────────────────────────────────────────────────────────────────────

/*
 * NO HAND-WRITTEN RESPONSE TYPES, NO RAW `sessionFetch`.
 *
 * This screen declared four interfaces and four fetchers against hand-built URLs, while all four routes
 * are in the generated client. The finops screen showed where that ends: its hand-written `PagedResult`
 * drifted from the API and a stat tile read 0 forever. Generated types cannot drift.
 */
type ScoreSnapshot = components['schemas']['ScoreHistoryPointDto'];
export type BaselineCheck = components['schemas']['BaselineCheckDto'];

function useSecureScore() {
  return useQuery({
    queryKey: ['security-posture', 'score'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/security-posture/score');
      if (error || !data) throw new Error('Failed to load the secure score');
      return data;
    },
  });
}

function useScoreHistory(days: number) {
  return useQuery({
    queryKey: ['security-posture', 'history', days],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/security-posture/score/history', {
        params: { query: { days } },
      });
      if (error || !data) throw new Error('Failed to load the score history');
      return data;
    },
  });
}

function useBaseline() {
  return useQuery({
    queryKey: ['security-posture', 'baseline'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/security-posture/baseline');
      if (error || !data) throw new Error('Failed to load the baseline');
      return data;
    },
  });
}

// ── Sparkline SVG ─────────────────────────────────────────────────────────────

function Sparkline({ data }: { data: ScoreSnapshot[] }) {
  if (data.length < 2)
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-subtle">
        Syncing data…
      </div>
    );

  const W = 300;
  const H = 60;
  const PAD = 4;

  const vals = data.map((d) => parseFloat(d.percentageScore));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;

  const pts = vals.map((v, i) => {
    const x = PAD + (i / (vals.length - 1)) * (W - PAD * 2);
    const y = PAD + ((max - v) / range) * (H - PAD * 2);
    return `${x},${y}`;
  });

  const area = `M${pts.join('L')}L${W - PAD},${H - PAD}L${PAD},${H - PAD}Z`;
  const line = `M${pts.join('L')}`;

  const last = vals[vals.length - 1];
  const prev = vals[vals.length - 2];
  const trend = last > prev ? 'up' : last < prev ? 'down' : 'flat';
  const lastPt = pts[pts.length - 1].split(',');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={trend === 'up' ? '#22c55e' : '#ef4444'} stopOpacity="0.25" />
          <stop offset="100%" stopColor={trend === 'up' ? '#22c55e' : '#ef4444'} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark-fill)" />
      <path
        d={line}
        fill="none"
        stroke={trend === 'up' ? '#22c55e' : '#ef4444'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastPt[0]} cy={lastPt[1]} r="3" fill={trend === 'up' ? '#22c55e' : '#ef4444'} />
    </svg>
  );
}

// ── Score card ────────────────────────────────────────────────────────────────

function grade(pct: number): string {
  if (pct >= 80) return 'A';
  if (pct >= 65) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 35) return 'D';
  return 'F';
}

/**
 * Grade → tone.
 *
 * The colours were five raw palette classes (`text-emerald-600` … `text-red-600`), and the local
 * `StatusBadge` — which shadowed the shared component of the same name, the third file in this codebase
 * to do that — carried its own emerald/amber/red pairs WITH hand-written dark variants. Tones now, so a
 * grade and a status use the same six colours as everything else.
 */
const GRADE_TONE: Record<string, BadgeTone> = {
  A: 'green',
  B: 'green',
  C: 'amber',
  D: 'amber',
  F: 'red',
};

const GRADE_TEXT: Record<BadgeTone, string> = {
  green: 'text-success',
  amber: 'text-warning',
  red: 'text-danger',
  blue: 'text-info',
  violet: 'text-violet-fg',
  neutral: 'text-fg',
};

function gradeClass(g: string): string {
  return GRADE_TEXT[GRADE_TONE[g] ?? 'neutral'];
}

/** A baseline check's verdict. `not_applicable` says so rather than showing a colour for nothing. */

// ── Page ──────────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  asr: 'Attack Surface Reduction',
  firewall: 'Firewall',
  encryption: 'Encryption',
  endpoint: 'Endpoint',
  identity: 'Identity',
  other: 'Other',
};

export function SecurityPosturePage() {
  if (!FEATURES.SECURITY_POSTURE) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Security Posture"
          description="Microsoft Secure Score trends and baseline drift checks"
        />
        <UpgradeGate
          feature="Security Posture"
          requiredLicense="Microsoft 365 E3 / E5 or Microsoft Defender for Business"
          description="Secure Score monitoring and baseline drift checks require Microsoft Defender or an E3/E5 plan. Your current plan (Business Standard) does not include this capability."
          learnMoreHref="https://learn.microsoft.com/en-us/microsoft-365/security/defender/microsoft-secure-score"
        />
      </div>
    );
  }

  return <SecurityPostureContent />;
}

function SecurityPostureContent() {
  const qc = useQueryClient();

  const scoreQ = useSecureScore();
  const historyQ = useScoreHistory(30);
  const baselineQ = useBaseline();

  const syncMut = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/v1/security-posture/sync', {});
      // The API says WHY a sync failed — expired credentials, a Graph throttle, a missing tenant —
      // where this screen used to blame the credentials for all of them.
      if (error) throw new Error(apiErrorMessage(error, 'Sync failed.'));
    },
    onSuccess: () => {
      toast.success('Sync triggered — data will update shortly');
      void qc.invalidateQueries({ queryKey: ['security-posture'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const latest = scoreQ.data?.latest;
  const pct = latest ? parseFloat(latest.percentageScore) : null;
  const g = pct != null ? grade(pct) : null;
  const history = historyQ.data?.history ?? [];
  const summary = baselineQ.data?.summary ?? {};
  const checks = baselineQ.data?.checks ?? [];

  // Compute delta vs 7 days ago
  let delta: number | null = null;
  if (history.length >= 2) {
    const last = parseFloat(history[history.length - 1].percentageScore);
    const weekAgo = parseFloat(history[Math.max(0, history.length - 8)].percentageScore);
    delta = +(last - weekAgo).toFixed(1);
  }

  const categories = Object.keys(summary);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Security Posture"
        description="Microsoft Secure Score trends and baseline drift checks"
        actions={
          <Button
            variant="outline"
            onClick={() => syncMut.mutate()}
            disabled={syncMut.isPending}
            className="hover:border-border-strong"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', syncMut.isPending && 'animate-spin')} />
            Sync now
          </Button>
        }
      />

      {/* ── Score summary ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Score tile */}
        <div className="col-span-1 flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
            <Shield className="h-3.5 w-3.5" />
            Secure Score
          </div>
          {scoreQ.isLoading ? (
            <div className="h-12 animate-pulse rounded-lg bg-surface-muted" />
          ) : latest ? (
            <div className="flex items-end gap-3">
              <span className="text-4xl font-bold tabular-nums text-fg">{Math.round(pct!)}%</span>
              {g && <span className={cn('mb-1 text-2xl font-bold', gradeClass(g))}>{g}</span>}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">No data yet — run a sync to populate.</p>
          )}
          {latest && (
            <p className="text-xs text-fg-subtle">
              {latest.score} / {latest.maxScore} pts · {latest.scoreDate}
            </p>
          )}
          {delta != null && (
            <div
              className={cn(
                'flex items-center gap-1 text-sm font-medium',
                delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-600' : 'text-fg-muted',
              )}
            >
              {delta > 0 ? (
                <TrendingUp className="h-4 w-4" />
              ) : delta < 0 ? (
                <TrendingDown className="h-4 w-4" />
              ) : (
                <Minus className="h-4 w-4" />
              )}
              {delta > 0 ? '+' : ''}
              {delta}% vs 7 days ago
            </div>
          )}
        </div>

        {/* Sparkline */}
        <div className="col-span-2 flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            30-Day Trend
          </p>
          {historyQ.isLoading ? (
            <div className="h-16 animate-pulse rounded-lg bg-surface-muted" />
          ) : (
            <div className="h-16">
              <Sparkline data={history} />
            </div>
          )}
          {history.length > 0 && (
            <div className="flex justify-between text-xs text-fg-subtle">
              <span>{history[0].scoreDate}</span>
              <span>{history[history.length - 1].scoreDate}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Baseline summary ──────────────────────────────────────────────── */}
      {categories.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-fg">Baseline Checks by Category</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {categories.map((cat) => {
              const s = summary[cat];
              const passRate = s.total > 0 ? Math.round((s.pass / s.total) * 100) : 0;
              return (
                <div
                  key={cat}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"
                >
                  <p className="text-xs font-medium text-fg-muted">{CATEGORY_LABELS[cat] ?? cat}</p>
                  <p
                    className={cn(
                      'text-2xl font-bold tabular-nums',
                      passRate >= 80
                        ? 'text-emerald-600'
                        : passRate >= 50
                          ? 'text-amber-600'
                          : 'text-red-600',
                    )}
                  >
                    {passRate}%
                  </p>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        passRate >= 80
                          ? 'bg-emerald-500'
                          : passRate >= 50
                            ? 'bg-amber-500'
                            : 'bg-red-500',
                      )}
                      style={{ width: `${passRate}%` }}
                    />
                  </div>
                  <p className="text-xs text-fg-subtle">
                    {s.pass}/{s.total} pass
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <BaselinePanel checks={checks} isError={baselineQ.isError} />

      {/*
        A FAILED REQUEST IS NOT A MISSING INTEGRATION. This branch fired on `!latest`, which an error
        also produces — so a 403 or a 500 was diagnosed on screen as "no data yet" and the reader was
        told to go and rotate three server secrets that were fine.

        The two states now say different things, and the error one names no environment variables:
        the person hitting a 403 is not the person who edits the server's configuration.
      */}
      {!scoreQ.isLoading && scoreQ.isError && (
        <div
          role="alert"
          className="flex flex-col items-center gap-4 rounded-xl border border-border bg-surface p-12 text-center"
        >
          <ShieldAlert className="h-10 w-10 text-fg-subtle" />
          <div>
            <p className="font-medium text-fg">Couldn&apos;t load the security posture</p>
            <p className="mt-1 text-sm text-fg-muted">
              The score was not read, so nothing here reflects your tenant. Try again; if it keeps
              failing, you may not have permission to view it.
            </p>
          </div>
        </div>
      )}

      {!scoreQ.isLoading && !scoreQ.isError && !latest && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-border bg-surface p-12 text-center">
          <ShieldAlert className="h-10 w-10 text-fg-subtle" />
          <div>
            <p className="font-medium text-fg">No security posture data yet</p>
            <p className="mt-1 text-sm text-fg-muted">
              Nothing has been synced from Microsoft Graph yet. An administrator configures the
              integration, then runs a sync.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

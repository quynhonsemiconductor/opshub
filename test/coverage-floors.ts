/**
 * Keeps the coverage floors in `vitest.config.ts` honest.
 *
 * The floors are a ratchet in intent — the config says "Raise these as suites are added —
 * never lower them" — and nothing enforced it. So they drifted: the comment claimed
 * "floors set just below current coverage" and cited ~16% while actual coverage had reached
 * 22%, leaving 5-8 points of slack on every metric. With that much slack a third of the
 * suite can be deleted and `pnpm test:cov` still passes, which is the opposite of what a
 * floor is for.
 *
 * Adapted from rova's `coverage-include.spec.ts`, which guards the same class of bug in the
 * shape rova has it: a hand-enumerated `include` list that silently rots. opshub's include
 * is a glob, so that exact ratchet would pass forever and prove nothing — the drift here is
 * in the thresholds instead.
 *
 * Two directions, both of which matter:
 *
 *  - a floor ABOVE actual means CI is already broken (vitest fails the run anyway, but this
 *    reports it as the configuration error it is rather than a mystery);
 *  - a floor more than `MAX_SLACK` points BELOW actual means the floor has stopped
 *    protecting anything, and the fix is to raise it in the same commit that raised
 *    coverage.
 *
 * Pure functions so the checker itself is unit-tested — a drift check that is wrong reads
 * exactly like a passing one.
 */

/** Metrics vitest thresholds and the json-summary report have in common. */
export const METRICS = ['lines', 'statements', 'functions', 'branches'] as const;
export type Metric = (typeof METRICS)[number];

/**
 * How far a floor may sit below actual coverage before it is considered stale.
 *
 * 3 points, not 0: coverage moves by fractions of a point on any refactor that touches
 * instrumented lines without changing tests, and a zero-tolerance check would fail on
 * unrelated commits. Wide enough to absorb that, narrow enough that a deliberate 8-point
 * regression cannot hide inside it.
 */
export const MAX_SLACK = 3;

export interface CoverageTotals {
  [metric: string]: { pct: number } | undefined;
}

export interface Drift {
  metric: Metric;
  floor: number;
  actual: number;
  /** Positive when the floor sits below actual. */
  slack: number;
}

/** Floors that exceed measured coverage — the run is failing, or about to. */
export function floorsAboveActual(
  floors: Partial<Record<Metric, number>>,
  totals: CoverageTotals,
): Drift[] {
  return compare(floors, totals).filter((d) => d.slack < 0);
}

/** Floors that have fallen more than {@link MAX_SLACK} behind measured coverage. */
export function staleFloors(
  floors: Partial<Record<Metric, number>>,
  totals: CoverageTotals,
  maxSlack: number = MAX_SLACK,
): Drift[] {
  return compare(floors, totals).filter((d) => d.slack > maxSlack);
}

function compare(floors: Partial<Record<Metric, number>>, totals: CoverageTotals): Drift[] {
  const drifts: Drift[] = [];
  for (const metric of METRICS) {
    const floor = floors[metric];
    const actual = totals[metric]?.pct;
    // A metric absent from either side is not silently treated as 0 — that would report a
    // 100-point drift on a typo and bury the real ones.
    if (typeof floor !== 'number' || typeof actual !== 'number') continue;
    drifts.push({ metric, floor, actual, slack: Number((actual - floor).toFixed(2)) });
  }
  return drifts;
}

/**
 * Extract the `thresholds` block from a vitest config's SOURCE.
 *
 * Read from text rather than by importing the config: importing it executes
 * `process.loadEnvFile` and the plugin factories, and the numbers are what matter here, not
 * a working config object. Text also means the failure message can name the file a developer
 * has to edit.
 */
export function parseThresholds(configSource: string): Partial<Record<Metric, number>> {
  const block = /thresholds:\s*\{([^}]*)\}/.exec(
    configSource.slice(configSource.indexOf('coverage:')),
  );
  if (!block) throw new Error('Could not find a coverage `thresholds` block in the config');

  const floors: Partial<Record<Metric, number>> = {};
  for (const metric of METRICS) {
    const match = new RegExp(`\\b${metric}:\\s*([0-9.]+)`).exec(block[1]);
    if (match) floors[metric] = Number(match[1]);
  }
  return floors;
}

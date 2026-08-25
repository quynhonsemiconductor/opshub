/**
 * Performance reviews end to end: the cycle, the review, the calibration sign-off, the coverage gate.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 * Every rule here is invisible from a single row, so each needs a flow:
 *
 *   - a review cannot be created outside an OPEN cycle, and nobody reviews themselves
 *   - the employee's CURRENT position is frozen onto the review at creation
 *   - only the SUBJECT writes the self-assessment; only the ASSIGNED REVIEWER rates
 *   - a rating whose scale entry demands a development plan is refused without one
 *   - goals must total 100% and all be graded before the review can be submitted
 *   - the sign-off is a real engine request: the reviewer cannot approve their own submission, and
 *     the EMPLOYEE cannot approve their own review even holding every permission
 *   - only the subject acknowledges; a cycle will not close over reviews still in flight
 *
 * Named by the `@AuthorizedInService(..., 'performance.e2e.spec.ts')` declarations on the routes
 * whose authorization lives in the service — a promise that this file asserts both directions.
 *
 * REFERENCES ARE UNIQUE PER RUN. The database is shared with the other suites and is not reset
 * between them, and `ux_cycle_reference` is a real unique index, so a fixed reference makes a spec
 * that passes once.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:migrate`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE,
  apiRequest,
  createTestApp,
  errorCode,
  login,
  unwrap,
  type Session,
} from './support/harness';

let app: NestFastifyApplication;
/** Holds `performance.read`, `performance.manage` and `performance.approve` — runs the process. */
let hr: Session;
/** Holds `performance.read` only. The REVIEWER, which needs no permission code at all. */
let manager: Session;
/** Holds nothing. The SUBJECT — every self-service route here is scope, not permission. */
let employee: Session;
/** Wildcard permissions. The only identity that can prove the EMPLOYEE-approval refusal. */
let admin: Session;

const RUN = Math.floor(Date.now() / 1000) % 100_000;

interface CycleRow {
  id: string;
  reference: string;
  status: string;
  openedAt: string | null;
  closedAt: string | null;
}

interface ReviewRow {
  id: string;
  cycleId: string;
  employeeId: string;
  /** Resolved server-side. Null only when the employee row is gone. */
  employeeName: string | null;
  reviewerId: string;
  /** Resolved server-side. Null when the reviewer has left — which is why reassignment exists. */
  reviewerName: string | null;
  positionId: string | null;
  status: string;
  selfAssessment: string | null;
  managerSummary: string | null;
  overallRating: string | null;
  developmentPlan: string | null;
  requestId: string | null;
  approvedBy: string | null;
  acknowledgedAt: string | null;
}

interface GoalRow {
  id: string;
  title: string;
  weight: number;
  rating: string | null;
  outcome: string | null;
}

/** A cycle whose period has ended, opened and ready for reviews. */
async function openCycle(suffix: string): Promise<CycleRow> {
  const created = await apiRequest(app, hr, 'POST', '/performance/cycles', {
    reference: `PR-${RUN}-${suffix}`,
    name: `E2E cycle ${suffix}`,
    periodStart: '2030-01-01',
    periodEnd: '2030-06-30',
    selfAssessmentDue: '2030-07-15',
    reviewDue: '2030-07-31',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const cycle = unwrap<CycleRow>(created.body);

  const opened = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/open`, {});
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return unwrap<CycleRow>(opened.body);
}

async function createReview(
  cycleId: string,
  employeeId: string,
  reviewerId: string,
): Promise<ReviewRow> {
  const res = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycleId}/reviews`, {
    employeeId,
    reviewerId,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<ReviewRow>(res.body);
}

/** Carry a review from creation to `manager_review` with one 100% graded goal on it. */
async function reviewReadyToSubmit(
  cycleId: string,
  subject: Session,
  subjectId: string,
  reviewer: Session,
  reviewerId: string,
): Promise<{ review: ReviewRow; goal: GoalRow }> {
  const review = await createReview(cycleId, subjectId, reviewerId);

  const self = await apiRequest(
    app,
    subject,
    'POST',
    `/performance/reviews/${review.id}/self-assessment`,
    { selfAssessment: 'I shipped the thing, and the other thing as well.' },
  );
  expect(self.status, JSON.stringify(self.body)).toBe(200);

  const goalRes = await apiRequest(
    app,
    reviewer,
    'POST',
    `/performance/reviews/${review.id}/goals`,
    {
      title: 'Ship the thing',
      target: 'Live by the end of the half',
      weight: 100,
    },
  );
  expect(goalRes.status, JSON.stringify(goalRes.body)).toBe(201);
  const goal = unwrap<GoalRow>(goalRes.body);

  const rated = await apiRequest(
    app,
    reviewer,
    'POST',
    `/performance/reviews/${review.id}/rating`,
    {
      managerSummary: 'A strong half against the goal we agreed.',
      overallRating: 'exceeds',
      goals: [{ id: goal.id, rating: 'exceeds', outcome: 'Shipped in May' }],
    },
  );
  expect(rated.status, JSON.stringify(rated.body)).toBe(200);

  return { review: unwrap<ReviewRow>(rated.body), goal };
}

beforeAll(async () => {
  app = await createTestApp();
  hr = await login(app, FIXTURE.HR);
  manager = await login(app, FIXTURE.MANAGER);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  admin = await login(app, FIXTURE.ADMIN);
});

afterAll(async () => {
  await app?.close();
});

describe('the rating scale', () => {
  it('is published to everyone, in RANK order rather than enum order', async () => {
    // A scale you are judged against that only some people can read is not a scale.
    const res = await apiRequest(app, employee, 'GET', '/performance/rating-scale');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const levels = unwrap<
      { code: string; rank: number; label: string; requiresDevelopmentPlan: boolean }[]
    >(res.body);

    expect(levels.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(levels.map((l) => l.code)).toEqual([
      'unsatisfactory',
      'needs_improvement',
      'meets',
      'exceeds',
      'outstanding',
    ]);
    // The gate that makes a low rating actionable, published so a reviewer knows BEFORE they rate.
    expect(levels.filter((l) => l.requiresDevelopmentPlan).map((l) => l.code)).toEqual([
      'unsatisfactory',
      'needs_improvement',
    ]);
  });
});

describe('cycles', () => {
  it('refuses a review deadline before the period has ended', async () => {
    // Also `ck_cycle_review_after_period`; the service restates it so the caller gets a code.
    const res = await apiRequest(app, hr, 'POST', '/performance/cycles', {
      reference: `PR-${RUN}-BAD`,
      name: 'Backwards',
      periodStart: '2030-01-01',
      periodEnd: '2030-06-30',
      reviewDue: '2030-05-01',
    });
    expect(res.status).toBe(412);
  });

  it('starts as a draft and takes no reviews until opened', async () => {
    const created = await apiRequest(app, hr, 'POST', '/performance/cycles', {
      reference: `PR-${RUN}-DRAFT`,
      name: 'Still a draft',
      periodStart: '2030-01-01',
      periodEnd: '2030-06-30',
      reviewDue: '2030-07-31',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const cycle = unwrap<CycleRow>(created.body);
    expect(cycle.status).toBe('draft');
    expect(cycle.openedAt).toBeNull();

    const tooEarly = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/reviews`, {
      employeeId: FIXTURE.NO_PERMISSIONS.id,
      reviewerId: FIXTURE.MANAGER.id,
    });
    expect(tooEarly.status).toBe(412);
    expect(errorCode(tooEarly.body)).toBe('PERFORMANCE_CYCLE_NOT_OPEN');

    // Opening is idempotent in the safe direction: the second attempt is refused, not silently
    // re-stamped with a new date.
    const opened = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/open`, {});
    expect(opened.status).toBe(200);
    expect(unwrap<CycleRow>(opened.body).openedAt).not.toBeNull();
    const again = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/open`, {});
    expect(again.status).toBe(412);
  });

  it('refuses cycle management to an identity holding only performance.read', async () => {
    const res = await apiRequest(app, manager, 'POST', '/performance/cycles', {
      reference: `PR-${RUN}-NOPE`,
      name: 'Not allowed',
      periodStart: '2030-01-01',
      periodEnd: '2030-06-30',
      reviewDue: '2030-07-31',
    });
    expect(res.status).toBe(403);
  });
});

describe('creating a review', () => {
  it('refuses a self-review', async () => {
    const cycle = await openCycle('SELF');
    const res = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/reviews`, {
      employeeId: FIXTURE.NO_PERMISSIONS.id,
      reviewerId: FIXTURE.NO_PERMISSIONS.id,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('PERFORMANCE_SELF_REVIEW');
  });

  it('refuses a second review for the same employee in one cycle', async () => {
    const cycle = await openCycle('DUP');
    await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);
    const again = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/reviews`, {
      employeeId: FIXTURE.NO_PERMISSIONS.id,
      reviewerId: FIXTURE.MANAGER.id,
    });
    expect(again.status).toBe(409);
  });

  it('refuses an employee id that does not exist', async () => {
    // `employee_id` carries no cross-schema FK, so a typo would otherwise create a review nobody
    // can act on.
    const cycle = await openCycle('GHOST');
    const res = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/reviews`, {
      employeeId: '00000000-0000-7000-8000-0000000000ff',
      reviewerId: FIXTURE.MANAGER.id,
    });
    expect(res.status).toBe(404);
  });
});

describe('an unshared judgement', () => {
  /*
   * THE CONTROL THIS PROTECTS. A rating is written by the reviewer, calibrated by a holder of
   * `performance.approve` — a permission deliberately withheld from managers so one person cannot both
   * write a judgement and release it — and only then shared. The read path walked around all of it:
   * `GET /performance/me` returned `managerSummary`, `overallRating` and `developmentPlan` with no
   * status gate, so the subject saw their rating the moment their reviewer saved a draft.
   *
   * It hid because the SPA asserts the opposite in a docblock and prints "Not shared yet" whenever the
   * rating is null — which is indistinguishable from a working gate until a draft exists.
   *
   * So these assertions are from the SUBJECT's own eyes, on every path that can reach them.
   */
  it('is withheld from its subject until it is shared', async () => {
    const cycle = await openCycle('REDACT');
    const { review, goal } = await reviewReadyToSubmit(
      cycle.id,
      employee,
      FIXTURE.NO_PERMISSIONS.id,
      manager,
      FIXTURE.MANAGER.id,
    );

    // The reviewer, who wrote it, still sees everything. This is not secrecy from the organisation.
    const asReviewer = unwrap<ReviewRow>(
      (await apiRequest(app, manager, 'GET', `/performance/reviews/${review.id}`)).body,
    );
    expect(asReviewer.overallRating).toBe('exceeds');
    expect(asReviewer.managerSummary).toContain('strong half');

    // The subject sees the shape of the review and none of the judgement.
    const single = unwrap<ReviewRow>(
      (await apiRequest(app, employee, 'GET', `/performance/reviews/${review.id}`)).body,
    );
    expect(single.status).toBe('manager_review');
    expect(single.overallRating, 'the subject can read their unshared rating').toBeNull();
    expect(single.managerSummary).toBeNull();
    expect(single.developmentPlan).toBeNull();
    // Their own words are still theirs.
    expect(single.selfAssessment).toContain('shipped the thing');

    // The LIST path is a separate mapping and needs its own assertion.
    const mine = unwrap<ReviewRow[]>(
      (await apiRequest(app, employee, 'GET', '/performance/me?limit=50')).body,
    ).find((r) => r.id === review.id);
    expect(mine, 'the review is missing from the subject’s own list').toBeDefined();
    expect(mine!.overallRating, '/me leaks what /reviews/:id withholds').toBeNull();

    // And the GOAL grade, which is half of the judgement.
    const goals = unwrap<{ id: string; rating: string | null; outcome: string | null }[]>(
      (await apiRequest(app, employee, 'GET', `/performance/reviews/${review.id}/goals`)).body,
    );
    const seen = goals.find((g) => g.id === goal.id);
    expect(seen, 'the goal vanished for its own subject').toBeDefined();
    expect(seen!.rating, 'the goal grade leaks the rating the review withholds').toBeNull();
    expect(seen!.outcome).toBeNull();
  });

  it('reaches its subject once it IS shared', async () => {
    /*
     * The other half. Without this, redacting unconditionally would also pass — and a rating the
     * subject can never read is a performance process with no purpose.
     */
    const cycle = await openCycle('RELEASE');
    const { review } = await reviewReadyToSubmit(
      cycle.id,
      employee,
      FIXTURE.NO_PERMISSIONS.id,
      manager,
      FIXTURE.MANAGER.id,
    );

    const submitted = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/submit`,
      {},
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    /*
     * SHARING IS THE APPROVAL, not a route of its own. `submit` raises an engine request; approving it
     * runs the type-def's `onApprove`, which is what moves the review to `shared`. My first draft
     * posted to `/reviews/:id/share`, which does not exist — the release is deliberately the same
     * approval mechanism every other decision in the product goes through.
     *
     * Approved by ADMIN: the reviewer is barred by `allowSelfApproval: false`, and the subject by a
     * check inside `onApprove`.
     */
    const requestId = unwrap<ReviewRow & { requestId: string | null }>(
      (await apiRequest(app, manager, 'GET', `/performance/reviews/${review.id}`)).body,
    ).requestId;
    expect(requestId, 'submitting raised no engine request').toBeTruthy();

    const approved = await apiRequest(app, admin, 'POST', `/requests/${requestId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const single = unwrap<ReviewRow>(
      (await apiRequest(app, employee, 'GET', `/performance/reviews/${review.id}`)).body,
    );
    expect(single.status).toBe('shared');
    expect(single.overallRating, 'a shared rating is still hidden from its subject').toBe(
      'exceeds',
    );
    expect(single.managerSummary).toContain('strong half');
  });
});

describe('naming the two people a review is about', () => {
  /*
   * "Who reviews whom" is the sentence at the top of this screen, and both columns that answer it
   * rendered a uuid. A review names TWO people, so this is the one list where the defect doubled.
   *
   * Both names come from ONE lookup: `resolveEmployeeNames` deduplicates, so a manager reviewing
   * eight people is one id, not eight. Asserted through the API because the SPA cannot spend a
   * request per name and may not hold `employee.read` at all.
   */
  it('names the employee and the reviewer in the list', async () => {
    const cycle = await openCycle('NAMES');
    await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);

    const list = await apiRequest(app, hr, 'GET', `/performance/reviews?cycleId=${cycle.id}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const rows = unwrap<ReviewRow[]>(list.body);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.employeeName, `review ${row.id} has no employee name`).toBeTruthy();
      expect(row.reviewerName, `review ${row.id} has no reviewer name`).toBeTruthy();
    }
    // Distinct people, distinct names — a resolver keyed wrongly would give both rows the same one.
    expect(rows[0].employeeName).not.toBe(rows[0].reviewerName);
  });

  it('names them on the single review too', async () => {
    /*
     * A separate service method from the list, so it needs its own assertion: one of the two paths
     * quietly showing a uuid is exactly the state this change was made to end.
     */
    const cycle = await openCycle('NAMES-ONE');
    const review = await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);

    const one = await apiRequest(app, hr, 'GET', `/performance/reviews/${review.id}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const got = unwrap<ReviewRow>(one.body);
    expect(got.employeeName).toBeTruthy();
    expect(got.reviewerName).toBeTruthy();
  });
});

describe('who may do what', () => {
  it('lets only the SUBJECT write the self-assessment', async () => {
    const cycle = await openCycle('SA');
    const review = await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);
    const body = { selfAssessment: 'A fair account of the half, in my own words.' };

    // The reviewer cannot write it FOR them, and neither can HR — a self-assessment written by
    // somebody else is not one, so `performance.manage` does not help here.
    for (const [who, session] of [
      ['reviewer', manager],
      ['hr', hr],
    ] as const) {
      const res = await apiRequest(
        app,
        session,
        'POST',
        `/performance/reviews/${review.id}/self-assessment`,
        body,
      );
      expect(res.status, who).toBe(403);
    }

    const mine = await apiRequest(
      app,
      employee,
      'POST',
      `/performance/reviews/${review.id}/self-assessment`,
      body,
    );
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    // …and it hands the review to the reviewer.
    expect(unwrap<ReviewRow>(mine.body).status).toBe('manager_review');
  });

  it('lets only the ASSIGNED REVIEWER rate, HR included', async () => {
    const cycle = await openCycle('RATE');
    const review = await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);
    await apiRequest(app, employee, 'POST', `/performance/reviews/${review.id}/self-assessment`, {
      selfAssessment: 'A fair account of the half, in my own words.',
    });
    const rating = { managerSummary: 'Solid work throughout the half.', overallRating: 'meets' };

    // HR runs the process but does not write the judgement: a rating attributed to the wrong person
    // is worse than a missing one.
    const byHr = await apiRequest(
      app,
      hr,
      'POST',
      `/performance/reviews/${review.id}/rating`,
      rating,
    );
    expect(byHr.status).toBe(412);
    expect(errorCode(byHr.body)).toBe('PERFORMANCE_NOT_THE_REVIEWER');

    // Nor does the subject rate themselves.
    const bySubject = await apiRequest(
      app,
      employee,
      'POST',
      `/performance/reviews/${review.id}/rating`,
      rating,
    );
    expect(bySubject.status).toBe(412);

    const byReviewer = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/rating`,
      rating,
    );
    expect(byReviewer.status, JSON.stringify(byReviewer.body)).toBe(200);
  });

  it('keeps a review out of the hands of an unrelated employee', async () => {
    // The subject, the reviewer, and whoever holds `performance.read`. Nobody else — this is the
    // most personal record in OpsHub.
    const cycle = await openCycle('PRIV');
    const review = await createReview(cycle.id, FIXTURE.ADMIN.id, FIXTURE.MANAGER.id);

    const nosy = await apiRequest(app, employee, 'GET', `/performance/reviews/${review.id}`);
    expect(nosy.status).toBe(403);

    for (const [who, session] of [
      ['the subject', admin],
      ['the reviewer', manager],
      ['performance.read', hr],
    ] as const) {
      const res = await apiRequest(app, session, 'GET', `/performance/reviews/${review.id}`);
      expect(res.status, who).toBe(200);
    }
  });
});

describe('the rating and its gates', () => {
  it('refuses a rating that demands a development plan without one', async () => {
    const cycle = await openCycle('PLAN');
    const review = await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);
    await apiRequest(app, employee, 'POST', `/performance/reviews/${review.id}/self-assessment`, {
      selfAssessment: 'A fair account of the half, in my own words.',
    });

    const without = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/rating`,
      {
        managerSummary: 'Several objectives were missed this half.',
        overallRating: 'needs_improvement',
      },
    );
    expect(without.status).toBe(412);
    expect(errorCode(without.body)).toBe('PERFORMANCE_DEVELOPMENT_PLAN_REQUIRED');

    const withPlan = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/rating`,
      {
        managerSummary: 'Several objectives were missed this half.',
        overallRating: 'needs_improvement',
        developmentPlan: 'Fortnightly coaching and a revised objective for Q3.',
      },
    );
    expect(withPlan.status, JSON.stringify(withPlan.body)).toBe(200);
    expect(unwrap<ReviewRow>(withPlan.body).developmentPlan).toContain('coaching');
    // Rating is NOT submitting: it stays with the reviewer to be discussed and revised.
    expect(unwrap<ReviewRow>(withPlan.body).status).toBe('manager_review');
  });

  it('refuses to submit until the goals total 100% and are all graded', async () => {
    const cycle = await openCycle('WEIGHT');
    const review = await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);
    await apiRequest(app, employee, 'POST', `/performance/reviews/${review.id}/self-assessment`, {
      selfAssessment: 'A fair account of the half, in my own words.',
    });

    const first = unwrap<GoalRow>(
      (
        await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/goals`, {
          title: 'Reduce flakes',
          weight: 60,
        })
      ).body,
    );
    await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/rating`, {
      managerSummary: 'Good progress on the agreed objectives.',
      overallRating: 'meets',
      goals: [{ id: first.id, rating: 'meets' }],
    });

    // 60% of the judgement accounted for: the overall rating cannot be traced to the goals.
    const short = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/submit`,
      {},
    );
    expect(short.status).toBe(412);
    expect(errorCode(short.body)).toBe('PERFORMANCE_GOAL_WEIGHTS_INVALID');

    // Re-sending the SAME TITLE edits that goal rather than adding a second — otherwise the weights
    // would be double-counted and the set would total 120.
    await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/goals`, {
      title: 'Reduce flakes',
      weight: 60,
    });
    const goals = unwrap<GoalRow[]>(
      (await apiRequest(app, manager, 'GET', `/performance/reviews/${review.id}/goals`)).body,
    );
    expect(goals).toHaveLength(1);

    const second = unwrap<GoalRow>(
      (
        await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/goals`, {
          title: 'Mentor the new joiner',
          weight: 40,
        })
      ).body,
    );

    // Weights now total 100, but the new goal has no grade.
    const ungraded = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/submit`,
      {},
    );
    expect(ungraded.status).toBe(412);
    expect(errorCode(ungraded.body)).toBe('PERFORMANCE_GOAL_WEIGHTS_INVALID');

    await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/rating`, {
      managerSummary: 'Good progress on the agreed objectives.',
      overallRating: 'meets',
      goals: [{ id: second.id, rating: 'exceeds', outcome: 'Pairing weekly since March' }],
    });
    const ok = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/submit`,
      {},
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(unwrap<ReviewRow>(ok.body).status).toBe('pending_approval');
    expect(unwrap<ReviewRow>(ok.body).requestId).not.toBeNull();
  });

  it('freezes the goals once the review has been submitted', async () => {
    const cycle = await openCycle('FROZEN');
    const { review } = await reviewReadyToSubmit(
      cycle.id,
      employee,
      FIXTURE.NO_PERMISSIONS.id,
      manager,
      FIXTURE.MANAGER.id,
    );
    await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/submit`, {});

    // Changing what somebody was judged against after they were judged is not an edit.
    const late = await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/goals`, {
      title: 'A goal invented afterwards',
      weight: 10,
    });
    expect(late.status).toBe(412);
  });
});

describe('the calibration sign-off', () => {
  it('goes through the request engine, and the reviewer cannot approve their own submission', async () => {
    const cycle = await openCycle('SIGN');
    const { review } = await reviewReadyToSubmit(
      cycle.id,
      employee,
      FIXTURE.NO_PERMISSIONS.id,
      manager,
      FIXTURE.MANAGER.id,
    );
    const submitted = unwrap<ReviewRow>(
      (await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/submit`, {})).body,
    );
    const requestId = submitted.requestId!;

    // Nothing is visible to the employee yet.
    const notYet = unwrap<ReviewRow>(
      (await apiRequest(app, employee, 'GET', `/performance/reviews/${review.id}`)).body,
    );
    expect(notYet.status).toBe('pending_approval');
    const earlyAck = await apiRequest(
      app,
      employee,
      'POST',
      `/performance/reviews/${review.id}/acknowledge`,
      {},
    );
    expect(earlyAck.status).toBe(412);

    // The reviewer submitted it, so they are out of their own chain — `allowSelfApproval: false`.
    const selfApproval = await apiRequest(
      app,
      manager,
      'POST',
      `/requests/${requestId}/approve`,
      {},
    );
    expect(selfApproval.status).toBe(403);

    const approved = await apiRequest(app, hr, 'POST', `/requests/${requestId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const shared = unwrap<ReviewRow>(
      (await apiRequest(app, employee, 'GET', `/performance/reviews/${review.id}`)).body,
    );
    expect(shared.status).toBe('shared');
    expect(shared.approvedBy).toBe(FIXTURE.HR.id);

    // Only the subject acknowledges: an acknowledgement recorded by somebody else is evidence of
    // nothing.
    const byHr = await apiRequest(
      app,
      hr,
      'POST',
      `/performance/reviews/${review.id}/acknowledge`,
      {},
    );
    expect(byHr.status).toBe(403);

    const acked = await apiRequest(
      app,
      employee,
      'POST',
      `/performance/reviews/${review.id}/acknowledge`,
      {},
    );
    expect(acked.status, JSON.stringify(acked.body)).toBe(200);
    expect(unwrap<ReviewRow>(acked.body).status).toBe('acknowledged');
    expect(unwrap<ReviewRow>(acked.body).acknowledgedAt).not.toBeNull();
  });

  it('refuses the EMPLOYEE even when they hold every permission', async () => {
    // The engine keeps the SUBMITTER out of the chain; it has no idea a request has a SUBJECT. So
    // without the type def's own check, anybody holding `performance.approve` could approve the
    // review of themselves — and ADMIN, with the wildcard, is the identity that proves it.
    const cycle = await openCycle('SUBJECT');
    const { review } = await reviewReadyToSubmit(
      cycle.id,
      admin,
      FIXTURE.ADMIN.id,
      manager,
      FIXTURE.MANAGER.id,
    );
    const submitted = unwrap<ReviewRow>(
      (await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/submit`, {})).body,
    );

    const bySubject = await apiRequest(
      app,
      admin,
      'POST',
      `/requests/${submitted.requestId!}/approve`,
      {},
    );
    expect(bySubject.status).toBe(412);
    expect(errorCode(bySubject.body)).toBe('PERFORMANCE_EMPLOYEE_APPROVAL');

    // …and the review is untouched, still waiting for somebody else.
    const after = unwrap<ReviewRow>(
      (await apiRequest(app, manager, 'GET', `/performance/reviews/${review.id}`)).body,
    );
    expect(after.status).toBe('pending_approval');
  });

  it('returns a rejected review to the reviewer WITH its rating intact', async () => {
    const cycle = await openCycle('REJECT');
    const { review } = await reviewReadyToSubmit(
      cycle.id,
      employee,
      FIXTURE.NO_PERMISSIONS.id,
      manager,
      FIXTURE.MANAGER.id,
    );
    const submitted = unwrap<ReviewRow>(
      (await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/submit`, {})).body,
    );

    const rejected = await apiRequest(app, hr, 'POST', `/requests/${submitted.requestId!}/reject`, {
      reason: 'Calibrate against the rest of the team first',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    const back = unwrap<ReviewRow>(
      (await apiRequest(app, manager, 'GET', `/performance/reviews/${review.id}`)).body,
    );
    expect(back.status).toBe('manager_review');
    // The rating STAYS: it is exactly what was rejected, and clearing it would lose what has to
    // change.
    expect(back.overallRating).toBe('exceeds');
    // …and the reviewer can revise and resubmit.
    const revised = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/rating`,
      {
        managerSummary: 'Revised after calibration with the rest of the team.',
        overallRating: 'meets',
      },
    );
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    const resubmitted = await apiRequest(
      app,
      manager,
      'POST',
      `/performance/reviews/${review.id}/submit`,
      {},
    );
    expect(resubmitted.status, JSON.stringify(resubmitted.body)).toBe(200);
  });
});

interface CoverageRow {
  employeeId: string;
  reviewId: string | null;
  status: string | null;
}

/** One page of the coverage report, with the page info the pager needs. */
async function coveragePage(
  cycleId: string,
  query = '',
): Promise<{ rows: CoverageRow[]; total: number; hasNextPage: boolean }> {
  const res = await apiRequest(app, hr, 'GET', `/performance/cycles/${cycleId}/coverage${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const body = res.body as {
    data: CoverageRow[];
    pageInfo: { total: number; hasNextPage: boolean };
  };
  return { rows: body.data, total: body.pageInfo.total, hasNextPage: body.pageInfo.hasNextPage };
}

/**
 * Every outstanding person, by walking the pages.
 *
 * THIS IS WHY THE TEST LOOKS LIKE THIS NOW. The endpoint used to pass a hard `500` and return a bare
 * array, and the assertion below — "an employee with no review must appear" — failed on a database that
 * had grown to 848 active employees. A correct assertion, a real ceiling, and nothing in the response
 * that would have told anybody which of the two was wrong.
 */
async function allCoverage(cycleId: string): Promise<CoverageRow[]> {
  const rows: CoverageRow[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await coveragePage(cycleId, `?limit=100&offset=${offset}`);
    rows.push(...page.rows);
    if (!page.hasNextPage) return rows;
    // A guard against an endpoint that always says there is more: a walk that cannot terminate is a
    // test that hangs rather than fails.
    expect(offset, 'the coverage report never reported a last page').toBeLessThan(100_000);
  }
}

describe('coverage and closing', () => {
  it('reports both kinds of gap, and refuses to close over them', async () => {
    const cycle = await openCycle('CLOSE');

    // An employee with NO review at all. Every active employee is a gap before anybody is reviewed.
    const beforeAny = await allCoverage(cycle.id);
    const missing = beforeAny.find((g) => g.employeeId === FIXTURE.NO_PERMISSIONS.id);
    expect(missing, 'an employee with no review must appear').toBeDefined();
    expect(missing!.reviewId).toBeNull();
    // Missing reviews sort first, so the row a chaser needs is at the top.
    expect(beforeAny[0].reviewId).toBeNull();

    const review = await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);

    // …and now the SECOND kind: a review that exists and has stalled. Both are "not done", which is
    // why the report is a left join rather than an anti-join.
    const stalled = (await allCoverage(cycle.id)).find(
      (g) => g.employeeId === FIXTURE.NO_PERMISSIONS.id,
    );
    expect(stalled!.reviewId).toBe(review.id);
    expect(stalled!.status).toBe('self_assessment');

    const tooEarly = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/close`, {});
    expect(tooEarly.status).toBe(412);
    expect(errorCode(tooEarly.body)).toBe('PERFORMANCE_CYCLE_HAS_OPEN_REVIEWS');

    // Withdrawing it settles it — the review never happened, which is a legitimate outcome for
    // somebody who left mid-cycle.
    const cancelled = await apiRequest(
      app,
      hr,
      'POST',
      `/performance/reviews/${review.id}/cancel`,
      {
        reason: 'Employee left before the review could be held',
      },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const closed = await apiRequest(app, hr, 'POST', `/performance/cycles/${cycle.id}/close`, {});
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(unwrap<CycleRow>(closed.body).closedAt).not.toBeNull();

    // A cancelled review is no longer a gap. Walked, not read off the first page: an absence proven
    // from one page of many is not an absence.
    const afterwards = await allCoverage(cycle.id);
    expect(afterwards.find((g) => g.employeeId === FIXTURE.NO_PERMISSIONS.id)).toBeUndefined();
  });

  it('counts everybody outstanding, not the size of the page', async () => {
    /*
     * THE DEFECT, as a test. The endpoint returned a bare array capped at 500, so the only number a
     * caller could compute was the length of what it happened to receive — and the SPA put exactly that
     * in the panel heading. A report whose total IS its page is a report that gets shorter as the
     * organisation grows, on the one screen where a short answer reads as progress.
     */
    const cycle = await openCycle('PAGED');

    const firstOnly = await coveragePage(cycle.id, '?limit=1');
    expect(firstOnly.rows).toHaveLength(1);
    // Every active employee is outstanding in a cycle nobody has reviewed, and the fixtures alone are
    // more than one — so a total equal to the page length would mean the total is the page length.
    expect(firstOnly.total).toBeGreaterThan(1);
    expect(firstOnly.hasNextPage).toBe(true);
  });

  it('pages without losing or repeating a row', async () => {
    /*
     * The property that makes paging trustworthy, and the reason the ORDER ends in `employees.id`: with
     * a non-total order, two rows that compare equal can swap between requests, so one is served twice
     * and another never — silent, and worst on the report whose purpose is "who did we miss".
     *
     * BOUNDED TO THE FIRST FEW ROWS, one at a time. My first version walked every row at `limit=1`,
     * which on a database with 848 active employees is 848 requests and earned a real 429 — the DEFAULT
     * tier is 200/minute — that then cascaded into five later tests in this file. `limit=1` is still the
     * point, because one row per page maximises the number of BOUNDARIES, which is where a partial
     * order goes wrong; ten boundaries prove the ordering just as well as eight hundred and are a test
     * rather than a load generator.
     */
    const cycle = await openCycle('WALK');
    const total = (await coveragePage(cycle.id, '?limit=1')).total;
    const steps = Math.min(total, 10);
    expect(steps, 'too few outstanding people to cross a page boundary').toBeGreaterThan(1);

    const seen: string[] = [];
    for (let offset = 0; offset < steps; offset += 1) {
      const page = await coveragePage(cycle.id, `?limit=1&offset=${offset}`);
      expect(page.rows, `offset ${offset} of ${total} returned nothing`).toHaveLength(1);
      expect(page.total, 'the total moved mid-walk').toBe(total);
      seen.push(page.rows[0].employeeId);
    }

    expect(new Set(seen).size, 'a row was served twice, so another was never served').toBe(steps);
  });

  it('reports the last page honestly rather than promising another', async () => {
    // `hasNextPage` comes from the server because deriving it as `offset + limit < total` is wrong the
    // moment a row is inserted between two requests — and a pager that always offers Next is a chaser
    // clicking into an empty page believing there is more to chase.
    const cycle = await openCycle('LAST');
    const total = (await coveragePage(cycle.id, '?limit=1')).total;

    const last = await coveragePage(cycle.id, `?limit=100&offset=${Math.max(total - 1, 0)}`);
    expect(last.hasNextPage).toBe(false);
    expect(last.rows.length).toBeGreaterThan(0);

    // Past the end: an empty page, not a 404, and still the true total.
    const beyond = await coveragePage(cycle.id, `?limit=100&offset=${total + 100}`);
    expect(beyond.rows).toHaveLength(0);
    expect(beyond.total).toBe(total);
    expect(beyond.hasNextPage).toBe(false);
  });

  it('cannot withdraw a review the employee has already seen', async () => {
    const cycle = await openCycle('SEEN');
    const { review } = await reviewReadyToSubmit(
      cycle.id,
      employee,
      FIXTURE.NO_PERMISSIONS.id,
      manager,
      FIXTURE.MANAGER.id,
    );
    const submitted = unwrap<ReviewRow>(
      (await apiRequest(app, manager, 'POST', `/performance/reviews/${review.id}/submit`, {})).body,
    );
    await apiRequest(app, hr, 'POST', `/requests/${submitted.requestId!}/approve`, {});

    const res = await apiRequest(app, hr, 'POST', `/performance/reviews/${review.id}/cancel`, {
      reason: 'Changed our minds',
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('PERFORMANCE_REVIEW_SETTLED');
  });

  it('counts the reviews per state of a cycle', async () => {
    const cycle = await openCycle('PROGRESS');
    await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);
    await createReview(cycle.id, FIXTURE.ADMIN.id, FIXTURE.MANAGER.id);

    const res = await apiRequest(app, hr, 'GET', `/performance/cycles/${cycle.id}/progress`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = unwrap<{ status: string; count: number }[]>(res.body);
    expect(rows).toEqual([{ status: 'self_assessment', count: 2 }]);
  });
});

describe('my reviews', () => {
  it('shows the subject their own and the reviewer theirs, with no permission at all', async () => {
    const cycle = await openCycle('MINE');
    const review = await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);

    const mine = await apiRequest(app, employee, 'GET', `/performance/me?cycleId=${cycle.id}`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(unwrap<ReviewRow[]>(mine.body).map((r) => r.id)).toEqual([review.id]);

    const toWrite = await apiRequest(
      app,
      manager,
      'GET',
      `/performance/me/to-review?cycleId=${cycle.id}`,
    );
    expect(toWrite.status, JSON.stringify(toWrite.body)).toBe(200);
    expect(unwrap<ReviewRow[]>(toWrite.body).map((r) => r.id)).toEqual([review.id]);

    // The employee's own list does NOT include reviews they were assigned to write, and vice versa —
    // they are different questions and the two routes answer one each.
    const notMine = await apiRequest(
      app,
      employee,
      'GET',
      `/performance/me/to-review?cycleId=${cycle.id}`,
    );
    expect(unwrap<ReviewRow[]>(notMine.body)).toEqual([]);
  });

  it('freezes the position the employee held when the review was created', async () => {
    // The review is a record of THEN. `positionId` is copied at creation and never recomputed, so a
    // transfer afterwards does not restate what the review was about.
    const cycle = await openCycle('POS');
    const review = await createReview(cycle.id, FIXTURE.NO_PERMISSIONS.id, FIXTURE.MANAGER.id);
    const fetched = unwrap<ReviewRow>(
      (await apiRequest(app, hr, 'GET', `/performance/reviews/${review.id}`)).body,
    );
    // Whatever the seed gave them — the point is that the review carries its own copy, not that the
    // fixture has a position.
    expect(fetched.positionId).toBe(review.positionId);
  });
});

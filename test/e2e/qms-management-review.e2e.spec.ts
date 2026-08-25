/**
 * QMS management review end to end: the composed agenda, the frozen snapshot, and §9.3.2(a).
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - THE AGENDA COMPOSES THE OTHER REGISTERS. A real overdue finding, a real unlinked audit finding
 *     and a real unassessed supplier all appear in it, which is the whole claim of §9.3.2 being
 *     satisfied by a join rather than by a second copy of the numbers.
 *   - HOLDING FREEZES IT. The snapshot on the held review still shows what the numbers were AFTER the
 *     underlying finding is contained and the counts move — a live re-read would not.
 *   - THE SNAPSHOT IS NEVER SETTABLE. `inputs` is not in any schema, so a caller cannot write minutes
 *     citing numbers nothing measured.
 *   - REVIEWS ARE HELD IN ORDER. §9.3.2(a) asks a review for the status of actions from PREVIOUS ones,
 *     which only means something if "previous" is settled.
 *   - CLOSING IS SEPARATE FROM HOLDING, needs the minutes and a conclusion, and stops the review
 *     raising further actions — one added then is an output the minutes do not contain.
 *   - §9.3.2(a) WORKS END TO END: an open action from an earlier review lands in the next review's
 *     frozen inputs, and drops off once completed.
 *
 * REFERENCES ARE UNIQUE PER RUN — `uq_management_review_reference` is global and the database is
 * shared with the other suites.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managementReviewActionCategoryEnum } from '../../db/schema/enums';
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
/** Holds the whole QMS management half. */
let security: Session;
/** Holds the read half only. */
let auditor: Session;
let admin: Session;
/** Holds no permission codes at all. */
let employee: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextReview = (): string => `E2E-MR-${RUN}-${++seq}`;
const nextNc = (): string => `E2E-MRNC-${RUN}-${++seq}`;

const CONCLUSION = 'The QMS remains effective; three improvement actions were raised and owned.';
const OUTCOME = 'Delivered in the July release and confirmed by a follow-up sample of ten items.';
const REASON = 'The board deferred the review to the next quarter.';
const CONTAINMENT = 'We re-ran the approval with two signatories and re-issued the release note.';
const MINUTES_DOC = '00000000-0000-7000-8000-00000000m1n1'.replace('m1n1', 'a1b2');

interface ReviewRow {
  id: string;
  reference: string;
  status: string;
  chairId: string;
  /** Resolved server-side on the READ paths. Null only when the employee row is gone. */
  chairName: string | null;
  scheduledFor: string | null;
  heldOn: string | null;
  inputs: Agenda | null;
  conclusion: string | null;
  minutesDocumentId: string | null;
  cancelReason: string | null;
}
interface ReviewListRow extends ReviewRow {
  actionCount: number;
  openActionCount: number;
}
interface Agenda {
  previousActions: { id: string; reviewReference: string; status: string }[];
  nonconformities: {
    containmentOverdue: number;
    overdueReferences: string[];
    recurringProcessAreas: string[];
  };
  audits: { findingsNotLinkedToAnAudit: number; unlinkedReferences: string[] };
  externalProviders: {
    reviewGaps: number;
    gapReferences: string[];
    criticalWithoutRisk: number;
    unassessedSpendLines: number;
  };
  risks: { untreated: number; untreatedReferences: string[] };
  assembledAt: string;
}
interface ActionRow {
  id: string;
  managementReviewId: string;
  category: string;
  status: string;
  ownerId: string;
  /** Resolved server-side on the READ paths. Null only when the employee row is gone. */
  ownerName: string | null;
  dueOn: string | null;
  completedAt: string | null;
  outcomeNote: string | null;
}

/** Schedule a review chaired by SECURITY. Overrides first, session second. */
async function scheduleReview(over: Record<string, unknown> = {}): Promise<ReviewRow> {
  const res = await apiRequest(app, security, 'POST', '/management-reviews', {
    reference: nextReview(),
    title: 'Half-year management review',
    period: `H1 ${RUN}`,
    chairId: FIXTURE.SECURITY.id,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<ReviewRow>(res.body);
}

async function hold(id: string): Promise<ReviewRow> {
  const res = await apiRequest(app, security, 'POST', `/management-reviews/${id}/hold`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return unwrap<ReviewRow>(res.body);
}

async function raiseAction(
  reviewId: string,
  over: Record<string, unknown> = {},
): Promise<ActionRow> {
  const res = await apiRequest(app, security, 'POST', `/management-reviews/${reviewId}/actions`, {
    category: 'improvement',
    description: 'Add a second approver to the release checklist and audit it next quarter.',
    ownerId: FIXTURE.HR.id,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<ActionRow>(res.body);
}

/** A finding overdue on containment, so the agenda has something real to count. */
async function overdueFinding(): Promise<{ id: string; reference: string }> {
  const res = await apiRequest(app, security, 'POST', '/nonconformances/report', {
    reference: nextNc(),
    title: 'Approval control not followed on release',
    description: 'The release was approved by one person where the procedure requires two.',
    requirement: 'SOP-12 section 4 requires two approvals before release.',
    source: 'internal_audit',
    severity: 'critical',
    processArea: `mr-agenda-${RUN}`,
    ownerId: FIXTURE.SECURITY.id,
    // `critical` allows one day of containment, so three days ago is overdue.
    detectedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<{ id: string; reference: string }>(res.body);
}

beforeAll(async () => {
  app = await createTestApp();
  security = await login(app, FIXTURE.SECURITY);
  auditor = await login(app, FIXTURE.AUDITOR);
  admin = await login(app, FIXTURE.ADMIN);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('the composed agenda', () => {
  it('counts a real overdue finding from the register that owns it', async () => {
    const finding = await overdueFinding();
    const agenda = unwrap<Agenda>(
      (await apiRequest(app, security, 'GET', '/management-reviews/agenda')).body,
    );
    // §9.3.2(c)(4). The number comes from the non-conformance register, not from a copy here.
    expect(agenda.nonconformities.containmentOverdue).toBeGreaterThan(0);
    expect(agenda.nonconformities.overdueReferences.length).toBeGreaterThan(0);
    // And (c)(6): the same finding claims an internal-audit source and names no audit.
    expect(agenda.audits.findingsNotLinkedToAnAudit).toBeGreaterThan(0);
    expect(agenda.audits.unlinkedReferences).toContain(finding.reference);
  });

  it('carries every §9.3.2 section the clause names', async () => {
    const agenda = unwrap<Agenda>(
      (await apiRequest(app, security, 'GET', '/management-reviews/agenda')).body,
    );
    // (a), (c)(4), (c)(6), (c)(7) and (e). A missing section is a clause nobody considered.
    for (const key of [
      'previousActions',
      'nonconformities',
      'audits',
      'externalProviders',
      'risks',
    ]) {
      expect(agenda, key).toHaveProperty(key);
    }
    expect(agenda.assembledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries counts and references, not the registers rows', async () => {
    // The narrowing is the control: returning rows here would make this a way around each register's
    // own permission. No owner ids, no supplier detail, no classification.
    await overdueFinding();
    const raw = JSON.stringify(
      unwrap<Agenda>((await apiRequest(app, security, 'GET', '/management-reviews/agenda')).body)
        .nonconformities,
    );
    expect(raw).not.toContain('ownerId');
    expect(raw).not.toContain('description');
  });
});

describe('naming the chair and the action owners', () => {
  /*
   * WHY THIS IS ASSERTED AT ALL. §9.3 makes the chair the accountable party for the review and §9.3.3
   * makes every output somebody's to deliver, and the drawer rendered `chairId` as a uuid while the
   * action card named nobody at all — so a queue could report an action three weeks overdue without
   * saying overdue on whom. The API has to answer it: `GET /v1/employees` needs `employee.read`, which
   * `management_review.read` does not imply.
   */
  it('names the chair on the programme row and on the single review', async () => {
    const review = await scheduleReview();

    const list = await apiRequest(
      app,
      security,
      'GET',
      `/management-reviews?search=${review.reference}&limit=100`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // Matched on the EXACT reference, not `[0]`: `search` is a substring match and these references
    // are sequential, so `E2E-MR-X-1` also matches `E2E-MR-X-10`.
    const row = unwrap<ReviewListRow[]>(list.body).find((r) => r.reference === review.reference);
    expect(row, `no programme row for ${review.reference}`).toBeDefined();
    expect(
      row!.chairName,
      `review ${row!.reference} came back with chair ${row!.chairId} and no name`,
    ).toBeTruthy();

    // The single-review read is a SEPARATE service method — `getWithChair`, added rather than widening
    // the `getById` that update, hold, close, cancel and `raiseAction` all share — so it needs its own
    // assertion. One of the two quietly showing a uuid is what this change exists to end.
    const one = await apiRequest(app, security, 'GET', `/management-reviews/${review.id}`);
    expect(one.status).toBe(200);
    expect(unwrap<ReviewRow>(one.body).chairName).toBe(row!.chairName);
  });

  it('names the action owner, who is not the chair', async () => {
    // Not held first, on purpose: the API accepts an action on a `scheduled` review, so this case
    // costs nothing to set up and does not drag the whole §9.3.2 agenda assembly in behind it.
    const review = await scheduleReview();
    const action = await raiseAction(review.id);

    const list = await apiRequest(
      app,
      security,
      'GET',
      `/management-reviews/actions?managementReviewId=${review.id}`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const row = unwrap<ActionRow[]>(list.body).find((a) => a.id === action.id);
    expect(row, 'the action just raised is not in the follow-up queue').toBeDefined();
    expect(
      row!.ownerName,
      `action ${row!.id} came back with owner ${row!.ownerId} and no name`,
    ).toBeTruthy();

    /*
     * The owner is HR and the chair is SECURITY, so this pins that the lookup reads the ACTION's
     * `ownerId` and not the review's `chairId`. Both are employee columns reachable from the same join,
     * and a resolver on the wrong one would still hand back a name for every row.
     */
    const chairName = unwrap<ReviewRow>(
      (await apiRequest(app, security, 'GET', `/management-reviews/${review.id}`)).body,
    ).chairName;
    expect(row!.ownerName).not.toBe(chairName);
  });
});

describe('holding a review', () => {
  it('freezes the agenda, and the snapshot does not move when the register does', async () => {
    // The whole reason the snapshot exists. A live re-read would turn the recorded number into
    // today's, and the decision minuted beside it would stop making sense.
    const finding = await overdueFinding();
    const review = await scheduleReview();
    const held = await hold(review.id);

    expect(held.status).toBe('held');
    expect(held.heldOn).not.toBeNull();
    const frozen = held.inputs!;
    expect(frozen.audits.unlinkedReferences).toContain(finding.reference);
    const frozenOverdue = frozen.nonconformities.containmentOverdue;
    expect(frozenOverdue).toBeGreaterThan(0);

    // Contain the finding — it leaves the overdue population.
    const contained = await apiRequest(
      app,
      security,
      'POST',
      `/nonconformances/${finding.id}/contain`,
      {
        containmentAction: CONTAINMENT,
      },
    );
    expect(contained.status, JSON.stringify(contained.body)).toBe(200);

    // The LIVE agenda has moved…
    const live = unwrap<Agenda>(
      (await apiRequest(app, security, 'GET', '/management-reviews/agenda')).body,
    );
    expect(live.nonconformities.overdueReferences).not.toContain(finding.reference);

    // …and the frozen one has not.
    const reread = unwrap<ReviewRow>(
      (await apiRequest(app, security, 'GET', `/management-reviews/${review.id}`)).body,
    );
    expect(reread.inputs!.nonconformities.containmentOverdue).toBe(frozenOverdue);
    expect(reread.inputs!.audits.unlinkedReferences).toContain(finding.reference);
  });

  it('will not accept a snapshot from the caller', async () => {
    // A caller who could supply `inputs` could minute numbers nothing measured.
    const review = await scheduleReview();
    const res = await apiRequest(app, security, 'PATCH', `/management-reviews/${review.id}`, {
      inputs: { nonconformities: { containmentOverdue: 0 } },
    });
    expect(res.status).toBe(422);
  });

  it('refuses to hold while a review scheduled earlier is still outstanding', async () => {
    // §9.3.2(a) asks this review for the status of actions from PREVIOUS ones.
    const earlier = await scheduleReview({ scheduledFor: '2026-01-31' });
    const later = await scheduleReview({ scheduledFor: '2026-06-30' });

    const res = await apiRequest(app, security, 'POST', `/management-reviews/${later.id}/hold`, {});
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('MANAGEMENT_REVIEW_OUT_OF_ORDER');

    // Settling the earlier one unblocks it, in either direction — held or cancelled.
    const cancelled = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/${earlier.id}/cancel`,
      {
        reason: REASON,
      },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const second = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/${later.id}/hold`,
      {},
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
  });

  it('refuses to hold twice, and refuses to edit once held', async () => {
    const review = await scheduleReview();
    await hold(review.id);

    const again = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/${review.id}/hold`,
      {},
    );
    expect(again.status).toBe(412);
    expect(errorCode(again.body)).toBe('MANAGEMENT_REVIEW_NOT_IN_STATE');

    const patched = await apiRequest(app, security, 'PATCH', `/management-reviews/${review.id}`, {
      period: 'H2 renamed after the fact',
    });
    expect(patched.status).toBe(412);
    expect(errorCode(patched.body)).toBe('MANAGEMENT_REVIEW_NOT_IN_STATE');
  });

  it('cannot cancel a review that has been held', async () => {
    const review = await scheduleReview();
    await hold(review.id);
    const res = await apiRequest(app, security, 'POST', `/management-reviews/${review.id}/cancel`, {
      reason: REASON,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('MANAGEMENT_REVIEW_NOT_IN_STATE');
  });
});

describe('closing (§9.3.3)', () => {
  it('needs the minutes and a conclusion, and is separate from holding', async () => {
    const review = await scheduleReview();

    // Not closable before it is held.
    const early = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/${review.id}/close`,
      {
        conclusion: CONCLUSION,
        minutesDocumentId: MINUTES_DOC,
      },
    );
    expect(early.status).toBe(412);
    expect(errorCode(early.body)).toBe('MANAGEMENT_REVIEW_NOT_IN_STATE');

    await hold(review.id);

    // Not closable without the minutes document.
    const noMinutes = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/${review.id}/close`,
      {
        conclusion: CONCLUSION,
      },
    );
    expect(noMinutes.status).toBe(422);

    const closed = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/${review.id}/close`,
      {
        conclusion: CONCLUSION,
        minutesDocumentId: MINUTES_DOC,
      },
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(unwrap<ReviewRow>(closed.body)).toMatchObject({
      status: 'closed',
      conclusion: CONCLUSION,
      minutesDocumentId: MINUTES_DOC,
    });
  });

  it('stops the review raising further actions once closed', async () => {
    // An action added then is an output the minutes do not contain.
    const review = await scheduleReview();
    await hold(review.id);
    await apiRequest(app, security, 'POST', `/management-reviews/${review.id}/close`, {
      conclusion: CONCLUSION,
      minutesDocumentId: MINUTES_DOC,
    });

    const res = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/${review.id}/actions`,
      {
        category: 'improvement',
        description: 'An action nobody minuted, raised after the minutes were issued.',
        ownerId: FIXTURE.HR.id,
      },
    );
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('MANAGEMENT_REVIEW_SETTLED');
  });

  it('allows actions on a held review, before the minutes are issued', async () => {
    const review = await scheduleReview();
    await hold(review.id);
    const action = await raiseAction(review.id, { category: 'resource_need' });
    expect(action.category).toBe('resource_need');
  });
});

describe('actions and §9.3.2(a)', () => {
  it('offers only §9.3.3s three categories', async () => {
    expect(new Set(managementReviewActionCategoryEnum.enumValues)).toEqual(
      new Set(['improvement', 'qms_change', 'resource_need']),
    );
    // And nothing else is accepted, so an action cannot be filed as unclassifiable.
    const review = await scheduleReview();
    const res = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/${review.id}/actions`,
      {
        category: 'other',
        description: 'An action that belongs to no category the clause names.',
        ownerId: FIXTURE.HR.id,
      },
    );
    expect(res.status).toBe(422);
  });

  it('carries an open action into the NEXT review frozen inputs, and drops it once completed', async () => {
    // §9.3.2(a) end to end, which is the reason the action table exists at all.
    const first = await scheduleReview({ scheduledFor: '2026-02-01' });
    await hold(first.id);
    const action = await raiseAction(first.id, { dueOn: '2026-03-01' });
    await apiRequest(app, security, 'POST', `/management-reviews/${first.id}/close`, {
      conclusion: CONCLUSION,
      minutesDocumentId: MINUTES_DOC,
    });

    // It shows on the carried-forward list…
    const carried = unwrap<{ id: string; daysOverdue: number | null }[]>(
      (await apiRequest(app, security, 'GET', '/management-reviews/actions/carried-forward')).body,
    );
    const mine = carried.find((a) => a.id === action.id);
    expect(mine, 'an open action from a closed review must be carried forward').toBeDefined();
    expect(mine!.daysOverdue).toBeGreaterThan(0);

    // …and lands in the next review's frozen snapshot.
    const second = await scheduleReview({ scheduledFor: '2026-08-01' });
    const held = await hold(second.id);
    expect(held.inputs!.previousActions.map((a) => a.id)).toContain(action.id);

    // Completing it takes it off the list.
    const completed = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/actions/${action.id}/complete`,
      { outcomeNote: OUTCOME },
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(unwrap<ActionRow>(completed.body).completedAt).not.toBeNull();

    const after = unwrap<{ id: string }[]>(
      (await apiRequest(app, security, 'GET', '/management-reviews/actions/carried-forward')).body,
    );
    expect(after.map((a) => a.id)).not.toContain(action.id);
  });

  it('does not offer a review its OWN actions as history', async () => {
    // At the moment a review is held, its own actions are outputs it has just produced.
    const review = await scheduleReview();
    await hold(review.id);
    const own = await raiseAction(review.id);

    const agenda = unwrap<Agenda>(
      (await apiRequest(app, security, 'GET', `/management-reviews/${review.id}/agenda`)).body,
    );
    expect(agenda.previousActions.map((a) => a.id)).not.toContain(own.id);

    // But the unscoped agenda, which belongs to no review, does show it.
    const all = unwrap<Agenda>(
      (await apiRequest(app, security, 'GET', '/management-reviews/agenda')).body,
    );
    expect(all.previousActions.map((a) => a.id)).toContain(own.id);
  });

  it('walks an action open to completed, and refuses a second completion', async () => {
    const review = await scheduleReview();
    const action = await raiseAction(review.id);

    const started = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/actions/${action.id}/start`,
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(unwrap<ActionRow>(started.body).status).toBe('in_progress');

    await apiRequest(app, security, 'POST', `/management-reviews/actions/${action.id}/complete`, {
      outcomeNote: OUTCOME,
    });
    const again = await apiRequest(
      app,
      security,
      'POST',
      `/management-reviews/actions/${action.id}/complete`,
      { outcomeNote: OUTCOME },
    );
    expect(again.status).toBe(412);
    expect(errorCode(again.body)).toBe('REVIEW_ACTION_NOT_IN_STATE');
  });

  it('reaches the action routes rather than parsing `actions` as a review id', async () => {
    // Nest matches in declaration order, so these share their segment count with `PATCH :id` and had
    // to be declared first. A 400 here would be `ParseUUIDPipe` rejecting the literal 'actions'.
    const review = await scheduleReview();
    const action = await raiseAction(review.id);
    const res = await apiRequest(
      app,
      security,
      'PATCH',
      `/management-reviews/actions/${action.id}`,
      {
        dueOn: '2027-01-31',
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<ActionRow>(res.body).dueOn).toBe('2027-01-31');
  });

  it('counts actions on the programme row', async () => {
    const review = await scheduleReview();
    const first = await raiseAction(review.id);
    await raiseAction(review.id);
    await apiRequest(app, security, 'POST', `/management-reviews/actions/${first.id}/complete`, {
      outcomeNote: OUTCOME,
    });

    const rows = unwrap<ReviewListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/management-reviews?search=${review.reference}&limit=100`,
        )
      ).body,
    );
    // Matched on the EXACT reference: `search` is a substring match and these are sequential.
    const row = rows.find((r) => r.reference === review.reference)!;
    expect(row.actionCount).toBe(2);
    expect(row.openActionCount).toBe(1);
  });
});

describe('permissions', () => {
  it('lets a read-only identity read the agenda but not schedule or hold', async () => {
    expect((await apiRequest(app, auditor, 'GET', '/management-reviews')).status).toBe(200);
    expect((await apiRequest(app, auditor, 'GET', '/management-reviews/agenda')).status).toBe(200);
    expect(
      (await apiRequest(app, auditor, 'GET', '/management-reviews/actions/carried-forward')).status,
    ).toBe(200);

    const scheduled = await apiRequest(app, auditor, 'POST', '/management-reviews', {
      reference: nextReview(),
      title: 'Auditor should not schedule this',
      period: `H2 ${RUN}`,
      chairId: FIXTURE.SECURITY.id,
    });
    expect(scheduled.status).toBe(403);

    const review = await scheduleReview();
    const held = await apiRequest(
      app,
      auditor,
      'POST',
      `/management-reviews/${review.id}/hold`,
      {},
    );
    expect(held.status).toBe(403);
  });

  it('refuses an identity holding no codes at all', async () => {
    expect((await apiRequest(app, employee, 'GET', '/management-reviews')).status).toBe(403);
    expect((await apiRequest(app, employee, 'GET', '/management-reviews/agenda')).status).toBe(403);
  });

  it('accepts the wildcard holder', async () => {
    expect((await apiRequest(app, admin, 'GET', '/management-reviews/agenda')).status).toBe(200);
  });
});

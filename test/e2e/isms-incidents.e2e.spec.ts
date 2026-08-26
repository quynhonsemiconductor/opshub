/**
 * ISMS incidents end to end: reporting, the state machine, the append-only timeline, the breach clock.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - ANY authenticated employee may REPORT one. An ISMS where raising an incident needs a role is
 *     one where incidents go unreported, so `POST /incidents/report` carries no permission — and
 *     handling still does.
 *   - THE STATE MACHINE, in both directions: each legal step works, each skipped step is refused
 *     with a code rather than the 500 a bare CHECK violation produces
 *   - THE TIMELINE IS WRITTEN BY THE TRANSITION and is APPEND-ONLY. Five status changes produce five
 *     entries in chronological order, and there is no route that edits or deletes one.
 *   - RESOLVING NEEDS A CAUSE, CLOSING NEEDS A LESSON (ISO 27001 A.5.27)
 *   - THE RECORD IS CORRECTABLE WHILE IT IS STILL BEING HANDLED. `PATCH /incidents/:id` is what makes
 *     the register a register rather than an append-only log of first impressions — and it is refused
 *     in both terminal states, refuses to move detection past a timestamp already recorded, and does
 *     not honour a reference sent with it.
 *   - THE 72-HOUR BREACH CLOCK: a breach detected more than 72 hours ago appears on the overdue
 *     report with the shortfall computed, drops off once notified, and cannot be notified twice
 *   - `incident.read` is not `incident.manage`
 *
 * REFERENCES ARE UNIQUE PER RUN — `uq_incident_reference` is global and the database is shared with
 * the other suites, so a fixed reference makes a spec that passes once.
 *
 * DETECTION TIMES ARE RELATIVE TO NOW, not fixed dates: the overdue report compares against `now()`,
 * so a breach pinned to a literal date would stop being "80 hours ago" the day after it was written.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
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
/** Holds `incident.read` + `incident.manage` — the responder. */
let security: Session;
/** Holds `incident.read` only. */
let auditor: Session;
/** Holds no permission codes at all — and must still be able to report. */
let employee: Session;
/** Only to create the hardware asset a correction links to — `asset.manage` is not the responder's. */
let admin: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextRef = (): string => `E2E-INC-${RUN}-${++seq}`;

const HOUR = 3_600_000;
/** `hours` ago, as an ISO string. Relative, so the overdue comparison stays meaningful. */
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

const CAUSE = 'A spoofed vendor email harvested one credential; MFA blocked the login attempt.';
const LESSON = 'Block the spoofed domain at the mail gateway and re-run awareness training.';

interface IncidentRow {
  id: string;
  reference: string;
  status: string;
  severity: string;
  detectedAt: string;
  reportedBy: string;
  assignedTo: string | null;
  containedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  rootCause: string | null;
  lessonsLearned: string | null;
  personalDataBreach: boolean;
  notificationDueAt: string | null;
  regulatorNotifiedAt: string | null;
  /** The risk this realised and the machine it happened on — both settable only by a correction. */
  riskId: string | null;
  assetId: string | null;
}
interface EventRow {
  id: string;
  type: string;
  detail: string;
  occurredAt: string;
}
interface OverdueRow {
  id: string;
  reference: string;
  hoursOverdue: number;
  notificationDueAt: string;
}

async function report(
  session: Session = security,
  over: Record<string, unknown> = {},
): Promise<IncidentRow> {
  const res = await apiRequest(app, session, 'POST', '/incidents/report', {
    reference: nextRef(),
    title: 'Phishing email reported by staff',
    description: 'A member of staff received a credential-harvesting email and clicked the link.',
    category: 'phishing',
    severity: 'high',
    detectedAt: hoursAgo(2),
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<IncidentRow>(res.body);
}

/** Report and walk to the requested status, asserting each step. */
async function walkTo(
  target: 'triaged' | 'contained' | 'resolved' | 'closed',
  over: Record<string, unknown> = {},
): Promise<IncidentRow> {
  let incident = await report(security, over);

  const step = async (url: string, payload: Record<string, unknown>) => {
    const res = await apiRequest(app, security, 'POST', `/incidents/${incident.id}${url}`, payload);
    expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(200);
    incident = unwrap<IncidentRow>(res.body);
  };

  await step('/triage', { assignedTo: FIXTURE.SECURITY.id });
  if (target === 'triaged') return incident;
  await step('/contain', {});
  if (target === 'contained') return incident;
  await step('/resolve', { rootCause: CAUSE });
  if (target === 'resolved') return incident;
  await step('/close', { lessonsLearned: LESSON });
  return incident;
}

beforeAll(async () => {
  app = await createTestApp();
  security = await login(app, FIXTURE.SECURITY);
  auditor = await login(app, FIXTURE.AUDITOR);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  admin = await login(app, FIXTURE.ADMIN);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('reporting', () => {
  it('lets an employee holding NO permissions report one', async () => {
    const incident = await report(employee);

    // The reporter comes from the token, not the payload.
    expect(incident.reportedBy).toBe(FIXTURE.NO_PERMISSIONS.id);
    expect(incident.status).toBe('reported');
  });

  it('refuses a duplicate reference and a future detection', async () => {
    const reference = nextRef();
    expect(
      (
        await apiRequest(app, security, 'POST', '/incidents/report', {
          reference,
          title: 'First',
          description: 'The first incident with this reference.',
          category: 'phishing',
          severity: 'low',
          detectedAt: hoursAgo(1),
        })
      ).status,
    ).toBe(201);

    const dup = await apiRequest(app, security, 'POST', '/incidents/report', {
      reference,
      title: 'Second',
      description: 'The same reference again, which must be refused.',
      category: 'phishing',
      severity: 'low',
      detectedAt: hoursAgo(1),
    });
    expect(dup.status).toBe(409);

    const future = await apiRequest(app, security, 'POST', '/incidents/report', {
      reference: nextRef(),
      title: 'From the future',
      description: 'Detected an hour from now, which cannot be true.',
      category: 'phishing',
      severity: 'low',
      detectedAt: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(future.status).toBe(412);
    expect(errorCode(future.body)).toBe('INCIDENT_TIMELINE_ORDER');

    /*
     * BUT NOW IS NOT THE FUTURE, even when the caller's clock is a little ahead of ours.
     *
     * The check used to be a strict `>` against `Date.now()`, and the timestamp is generated on the
     * CALLER's clock: a browser on a laptop that has been asleep, a container whose clock steps after
     * a host suspend. A one-millisecond skew became a refusal the user could not act on — they picked
     * "now" and were told "now" is in the future. It surfaced as an intermittently failing browser
     * journey, which is the shape a clock problem always takes.
     *
     * Asserted from both sides, in one case, because a tolerance is only correct if it still refuses
     * a real mistake: an hour ahead is refused above, thirty seconds ahead is accepted here, and
     * neither assertion means anything without the other.
     */
    const skewed = await apiRequest(app, security, 'POST', '/incidents/report', {
      reference: nextRef(),
      title: 'Reported by a client whose clock runs fast',
      description: 'Thirty seconds ahead of the server, which is skew and not a claim.',
      category: 'phishing',
      severity: 'low',
      /*
       * FIVE SECONDS, not thirty. The tolerance is two minutes, and in the full suite this assertion
       * failed while passing in isolation: the log timestamps show two clocks about a hundred seconds
       * apart in this environment, so a thirty-second lead measured on one clock was over two minutes
       * on the other. A test sitting near the boundary of the thing it is testing measures the
       * environment. Five seconds is still refused by a strict `>`, which is what this pins.
       */
      detectedAt: new Date(Date.now() + 5_000).toISOString(),
    });
    expect(skewed.status, JSON.stringify(skewed.body)).toBe(201);
  });

  it('opens the timeline at the detection time', async () => {
    const detectedAt = hoursAgo(6);
    const incident = await report(security, { detectedAt });

    const timeline = unwrap<EventRow[]>(
      (await apiRequest(app, security, 'GET', `/incidents/${incident.id}/timeline`)).body,
    );
    expect(timeline).toHaveLength(1);
    // Not "when the form was filled": the gap between detection and reporting is the first thing a
    // review looks at.
    expect(new Date(timeline[0].occurredAt).toISOString()).toBe(new Date(detectedAt).toISOString());
  });
});

describe('the state machine', () => {
  it('walks the whole sequence and stamps each timestamp', async () => {
    const closed = await walkTo('closed');

    expect(closed.status).toBe('closed');
    expect(closed.assignedTo).toBe(FIXTURE.SECURITY.id);
    expect(closed.containedAt).not.toBeNull();
    expect(closed.resolvedAt).not.toBeNull();
    expect(closed.closedAt).not.toBeNull();
    expect(closed.rootCause).toContain('spoofed vendor email');
    expect(closed.lessonsLearned).toContain('mail gateway');

    // Cumulative: closing does not erase the steps it passed through, which is what
    // `ck_incident_contained_pair` and its siblings are written as implications for.
    const detected = new Date(closed.detectedAt).getTime();
    expect(new Date(closed.containedAt!).getTime()).toBeGreaterThanOrEqual(detected);
    expect(new Date(closed.resolvedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(closed.containedAt!).getTime(),
    );
  });

  it('refuses each skipped step with a code', async () => {
    const reported = await report();
    for (const [url, payload] of [
      ['/contain', {}],
      ['/resolve', { rootCause: CAUSE }],
      ['/close', { lessonsLearned: LESSON }],
    ] as const) {
      const res = await apiRequest(
        app,
        security,
        'POST',
        `/incidents/${reported.id}${url}`,
        payload,
      );
      expect(res.status, url).toBe(412);
      expect(errorCode(res.body), url).toBe('INCIDENT_NOT_IN_STATE');
    }

    const triaged = await walkTo('triaged');
    const early = await apiRequest(app, security, 'POST', `/incidents/${triaged.id}/resolve`, {
      rootCause: CAUSE,
    });
    expect(early.status).toBe(412);

    const contained = await walkTo('contained');
    const tooSoon = await apiRequest(app, security, 'POST', `/incidents/${contained.id}/close`, {
      lessonsLearned: LESSON,
    });
    expect(tooSoon.status).toBe(412);
  });

  it('requires a responder to triage', async () => {
    const incident = await report();

    expect(
      (await apiRequest(app, security, 'POST', `/incidents/${incident.id}/triage`, {})).status,
    ).toBe(422);
    // `assigned_to` carries no cross-schema FK, so an unknown id must be refused here.
    const nobody = await apiRequest(app, security, 'POST', `/incidents/${incident.id}/triage`, {
      assignedTo: '00000000-0000-7000-8000-0000000000fe',
    });
    expect(nobody.status).toBe(404);
  });

  it('refuses handling timestamps that run backwards', async () => {
    const triaged = await walkTo('triaged', { detectedAt: hoursAgo(3) });

    const early = await apiRequest(app, security, 'POST', `/incidents/${triaged.id}/contain`, {
      containedAt: hoursAgo(10),
    });
    expect(early.status).toBe(412);
    expect(errorCode(early.body)).toBe('INCIDENT_TIMELINE_ORDER');
  });

  it('requires a cause to resolve and a lesson to close', async () => {
    const contained = await walkTo('contained');

    expect(
      (await apiRequest(app, security, 'POST', `/incidents/${contained.id}/resolve`, {})).status,
    ).toBe(422);
    expect(
      (
        await apiRequest(app, security, 'POST', `/incidents/${contained.id}/resolve`, {
          rootCause: 'dunno',
        })
      ).status,
    ).toBe(422);

    const resolved = await apiRequest(app, security, 'POST', `/incidents/${contained.id}/resolve`, {
      rootCause: CAUSE,
    });
    expect(resolved.status).toBe(200);

    expect(
      (await apiRequest(app, security, 'POST', `/incidents/${contained.id}/close`, {})).status,
    ).toBe(422);
    expect(
      (
        await apiRequest(app, security, 'POST', `/incidents/${contained.id}/close`, {
          lessonsLearned: 'none',
        })
      ).status,
    ).toBe(422);
  });

  it('dismisses early and refuses to dismiss after containment', async () => {
    const early = await report();
    const dismissed = await apiRequest(app, security, 'POST', `/incidents/${early.id}/dismiss`, {
      reason: 'It was a scheduled penetration test nobody had announced.',
    });
    expect(dismissed.status).toBe(200);
    expect(unwrap<IncidentRow>(dismissed.body).status).toBe('false_positive');
    // Terminal: no handling timestamps were invented on the way.
    expect(unwrap<IncidentRow>(dismissed.body).containedAt).toBeNull();

    const contained = await walkTo('contained');
    const late = await apiRequest(app, security, 'POST', `/incidents/${contained.id}/dismiss`, {
      reason: 'Trying to dismiss something already contained.',
    });
    // Once contained it demonstrably WAS an incident.
    expect(late.status).toBe(412);
    expect(errorCode(late.body)).toBe('INCIDENT_NOT_IN_STATE');
  });

  it('refuses edits once finished, but still accepts timeline entries', async () => {
    const closed = await walkTo('closed');

    const edit = await apiRequest(app, security, 'PATCH', `/incidents/${closed.id}`, {
      severity: 'low',
    });
    expect(edit.status).toBe(412);
    expect(errorCode(edit.body)).toBe('INCIDENT_NOT_IN_STATE');

    // A post-incident review adds to the record after closure; refusing that would push the
    // analysis somewhere the audit trail cannot see.
    const note = await apiRequest(app, security, 'POST', `/incidents/${closed.id}/timeline`, {
      type: 'note',
      detail: 'Post-incident review completed; actions tracked as risk treatments.',
    });
    expect(note.status).toBe(201);
  });
});

describe('the timeline', () => {
  it('records one entry per status change, chronologically', async () => {
    const closed = await walkTo('closed');

    const timeline = unwrap<EventRow[]>(
      (await apiRequest(app, security, 'GET', `/incidents/${closed.id}/timeline`)).body,
    );
    // Report, triage, contain, resolve, close — written by the transitions, not by the caller.
    expect(timeline.filter((e) => e.type === 'status_change')).toHaveLength(5);
    const times = timeline.map((e) => new Date(e.occurredAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('accepts a note dated when it happened, and refuses one before detection', async () => {
    const incident = await report(security, { detectedAt: hoursAgo(4) });

    const backdated = await apiRequest(
      app,
      security,
      'POST',
      `/incidents/${incident.id}/timeline`,
      {
        type: 'evidence',
        detail: 'Mail gateway log extract attached to the ticket.',
        occurredAt: hoursAgo(3),
      },
    );
    expect(backdated.status).toBe(201);
    expect(new Date(unwrap<EventRow>(backdated.body).occurredAt).getTime()).toBeLessThan(
      Date.now(),
    );

    const impossible = await apiRequest(
      app,
      security,
      'POST',
      `/incidents/${incident.id}/timeline`,
      {
        type: 'note',
        detail: 'Recorded against a time before the incident was detected.',
        occurredAt: hoursAgo(10),
      },
    );
    expect(impossible.status).toBe(412);
    expect(errorCode(impossible.body)).toBe('INCIDENT_TIMELINE_ORDER');
  });

  it('exposes no route that edits or deletes an entry', async () => {
    // Append-only is a property of the API surface, not just of the service: a timeline somebody can
    // revise afterwards is not evidence.
    const incident = await report();
    const created = await apiRequest(app, security, 'POST', `/incidents/${incident.id}/timeline`, {
      type: 'note',
      detail: 'An entry that must not be editable afterwards.',
    });
    expect(created.status).toBe(201);
    const eventId = unwrap<EventRow>(created.body).id;

    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const res = await apiRequest(
        app,
        security,
        method,
        `/incidents/${incident.id}/timeline/${eventId}`,
        {
          detail: 'Rewritten',
        },
      );
      // 404 or 405 — either way there is no handler. What matters is that nothing succeeds.
      expect([404, 405], `${method} returned ${res.status}`).toContain(res.status);
    }
  });
});

describe('the 72-hour breach clock', () => {
  it('reports a breach past the deadline, with the shortfall, and clears it on notification', async () => {
    const breach = await report(security, {
      title: 'Customer export exposed',
      description: 'A misconfigured bucket exposed a customer export for several hours.',
      category: 'data_loss',
      severity: 'critical',
      detectedAt: hoursAgo(80),
      personalDataBreach: true,
    });

    // Derived, not stored: `timestamptz + interval` cannot be a generated column.
    expect(breach.notificationDueAt).not.toBeNull();
    const due = new Date(breach.notificationDueAt!).getTime();
    expect(due - new Date(breach.detectedAt).getTime()).toBe(72 * HOUR);

    const overdue = unwrap<OverdueRow[]>(
      (await apiRequest(app, security, 'GET', '/incidents/breaches/overdue')).body,
    );
    const mine = overdue.find((o) => o.id === breach.id);
    expect(mine, 'the breach should be listed as overdue').toBeDefined();
    // 80 hours since detection, 72 allowed — computed in the query so nothing recalculates it.
    expect(mine!.hoursOverdue).toBeGreaterThanOrEqual(7);
    expect(mine!.hoursOverdue).toBeLessThanOrEqual(9);

    const notified = await apiRequest(
      app,
      security,
      'POST',
      `/incidents/${breach.id}/regulator-notified`,
      {},
    );
    expect(notified.status).toBe(200);
    expect(unwrap<IncidentRow>(notified.body).regulatorNotifiedAt).not.toBeNull();

    const after = unwrap<OverdueRow[]>(
      (await apiRequest(app, security, 'GET', '/incidents/breaches/overdue')).body,
    );
    expect(after.map((o) => o.id)).not.toContain(breach.id);

    // And it is on the timeline, because that is what a reviewer reads.
    const timeline = unwrap<EventRow[]>(
      (await apiRequest(app, security, 'GET', `/incidents/${breach.id}/timeline`)).body,
    );
    expect(timeline.some((e) => e.type === 'notification')).toBe(true);
  });

  it('does not report a breach still inside the window', async () => {
    const fresh = await report(security, {
      detectedAt: hoursAgo(2),
      personalDataBreach: true,
    });

    const overdue = unwrap<OverdueRow[]>(
      (await apiRequest(app, security, 'GET', '/incidents/breaches/overdue')).body,
    );
    expect(overdue.map((o) => o.id)).not.toContain(fresh.id);
  });

  it('refuses to notify twice, or to notify a non-breach', async () => {
    const breach = await report(security, { detectedAt: hoursAgo(80), personalDataBreach: true });
    expect(
      (await apiRequest(app, security, 'POST', `/incidents/${breach.id}/regulator-notified`, {}))
        .status,
    ).toBe(200);
    const twice = await apiRequest(
      app,
      security,
      'POST',
      `/incidents/${breach.id}/regulator-notified`,
      {},
    );
    // The notification date is what the obligation turns on, so overwriting it would erase whether
    // the 72 hours were met.
    expect(twice.status).toBe(409);

    const ordinary = await report();
    const notABreach = await apiRequest(
      app,
      security,
      'POST',
      `/incidents/${ordinary.id}/regulator-notified`,
      {},
    );
    expect(notABreach.status).toBe(412);
    expect(errorCode(notABreach.body)).toBe('INCIDENT_NOT_A_BREACH');
  });

  it('leaves notificationDueAt null when it is not a breach', async () => {
    const ordinary = await report();
    expect(ordinary.personalDataBreach).toBe(false);
    expect(ordinary.notificationDueAt).toBeNull();
  });
});

describe('the register view', () => {
  it('orders worst first and filters the open queue', async () => {
    const critical = await report(security, { severity: 'critical', detectedAt: hoursAgo(1) });
    const low = await report(security, { severity: 'low', detectedAt: hoursAgo(1) });

    const queue = unwrap<IncidentRow[]>(
      (await apiRequest(app, security, 'GET', '/incidents?openOnly=true&limit=100')).body,
    );
    const positions = [
      queue.findIndex((i) => i.id === critical.id),
      queue.findIndex((i) => i.id === low.id),
    ];
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[1]).toBeGreaterThanOrEqual(0);
    // Worst first — during a response that is the only useful order.
    expect(positions[0]).toBeLessThan(positions[1]);

    const closed = await walkTo('closed');
    expect(
      unwrap<IncidentRow[]>(
        (await apiRequest(app, security, 'GET', '/incidents?openOnly=true&limit=100')).body,
      ).map((i) => i.id),
    ).not.toContain(closed.id);
  });

  it('lists open incidents with no linked risk, and drops them once linked', async () => {
    const incident = await report();

    const unlinked = () =>
      apiRequest(app, security, 'GET', '/incidents/unlinked-to-risk').then((r) =>
        unwrap<IncidentRow[]>(r.body).map((i) => i.id),
      );
    expect(await unlinked()).toContain(incident.id);

    // Link it to a risk — the register's feedback loop closing.
    const risk = await apiRequest(app, security, 'POST', '/risks', {
      reference: `E2E-INC-R-${RUN}-${++seq}`,
      title: 'Phishing leading to credential compromise',
      description: 'Staff may click credential-harvesting links.',
      category: 'phishing',
      ownerId: FIXTURE.SECURITY.id,
      inherent: { likelihood: 4, impact: 3 },
    });
    expect(risk.status).toBe(201);

    const linked = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      riskId: unwrap<{ id: string }>(risk.body).id,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);

    expect(await unlinked()).not.toContain(incident.id);
  });
});

describe('correcting the record', () => {
  /*
   * WHY THIS BLOCK EXISTS.
   *
   * `PATCH /incidents/:id` shipped with the module and no screen called it, so in practice the register
   * was append-only: whatever severity somebody chose in the first ten minutes of a response was the
   * severity for ever. That is the field the response queue is ORDERED by, so a `critical` graded `low`
   * sinks to the bottom of the list the responders actually read — and the only ways out were to close
   * the incident and report a duplicate under a new reference (breaking every citation of the old one)
   * or to leave the record wrong.
   *
   * The screen now calls it, which is what makes each guard below reachable by a person rather than only
   * by a script: everything asserted here is something the correction form can attempt.
   */

  it('regrades a severity, and the register serves the correction', async () => {
    const incident = await report(security, { severity: 'low', detectedAt: hoursAgo(2) });

    const corrected = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      severity: 'critical',
      category: 'data_loss',
      title: 'Customer export exposed — not the phishing report it was first filed as',
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(unwrap<IncidentRow>(corrected.body).severity).toBe('critical');

    /*
     * READ BACK, and through the LIST rather than the record. The PATCH response echoing `critical`
     * only proves the service returned what it was given; the queue is what a responder reads, it is
     * ordered and filtered by severity in SQL, and an update that touched the response but not the row
     * would pass an assertion on the response alone. Both directions, because "now critical" without
     * "no longer low" would also pass against a row that had been duplicated rather than updated.
     */
    const queuedAs = async (value: string) =>
      unwrap<IncidentRow[]>(
        (await apiRequest(app, security, 'GET', `/incidents?severity=${value}&limit=100`)).body,
      ).map((i) => i.id);
    expect(await queuedAs('critical')).toContain(incident.id);
    expect(await queuedAs('low')).not.toContain(incident.id);
  });

  it('withdraws a wrongly-ticked breach, and the deadline goes with it', async () => {
    // A flag ticked by somebody being careful in the first minutes, and wrong: the export held no
    // personal data. Leaving it set leaves a GDPR Article 33 deadline on the record and the incident on
    // the overdue report, so this is a correction with a regulator on the other end of getting it wrong.
    const incident = await report(security, {
      personalDataBreach: true,
      detectedAt: hoursAgo(80),
    });
    expect(incident.notificationDueAt).not.toBeNull();
    expect(
      unwrap<OverdueRow[]>(
        (await apiRequest(app, security, 'GET', '/incidents/breaches/overdue')).body,
      ).map((o) => o.id),
    ).toContain(incident.id);

    const corrected = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      personalDataBreach: false,
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    const after = unwrap<IncidentRow>(corrected.body);
    expect(after.personalDataBreach).toBe(false);
    // DERIVED, so correcting the flag corrects the deadline — nothing has to remember to clear it.
    expect(after.notificationDueAt).toBeNull();
    expect(
      unwrap<OverdueRow[]>(
        (await apiRequest(app, security, 'GET', '/incidents/breaches/overdue')).body,
      ).map((o) => o.id),
    ).not.toContain(incident.id);
  });

  it('does not honour a reference sent with a correction', async () => {
    const incident = await report();

    const res = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      reference: nextRef(),
      severity: 'low',
    });
    /*
     * ACCEPTED AND IGNORED, which is the behaviour the form's disabled reference field relies on.
     * `UpdateIncidentSchema` omits `reference` and the pipe strips what the schema does not declare, so
     * the field cannot be renamed through this route at all — and it must not be, because the
     * post-incident report, the breach notification and any regulator correspondence quote it. Renaming
     * one would orphan every citation, which is why the schema omits it rather than making it optional.
     */
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<IncidentRow>(res.body).reference).toBe(incident.reference);
    expect(unwrap<IncidentRow>(res.body).severity).toBe('low');
  });

  it('refuses a correction in both terminal states', async () => {
    /*
     * BOTH, because the screen decides whether to draw its Correct action from one list and this is that
     * list. `closed` alone was already pinned above; `false_positive` is the one that gets forgotten —
     * it is reached by a different route (`/dismiss`) and is just as finished, and an action offered on
     * it would be a button whose only possible outcome is this refusal.
     */
    const closed = await walkTo('closed');
    const dismissed = await report();
    expect(
      (
        await apiRequest(app, security, 'POST', `/incidents/${dismissed.id}/dismiss`, {
          reason: 'A scheduled penetration test nobody had announced.',
        })
      ).status,
    ).toBe(200);

    for (const finished of [closed, dismissed]) {
      const res = await apiRequest(app, security, 'PATCH', `/incidents/${finished.id}`, {
        severity: 'low',
      });
      expect(res.status, finished.reference).toBe(412);
      // The CODE, not just the status: the screen shows the API's message, and this is the one that
      // tells a responder to add a timeline entry instead.
      expect(errorCode(res.body), finished.reference).toBe('INCIDENT_NOT_IN_STATE');
    }
  });

  it('moves detection earlier, and refuses it past a containment or into the future', async () => {
    /*
     * DETECTED SIX HOURS AGO, CONTAINED FIVE — both backdated, and the containment explicitly rather
     * than through `walkTo`, which stamps `now`. With containment at `now` there is no instant that is
     * both after it and not in the future, so the future check would answer first and this test would
     * pass while asserting nothing about the timestamp comparison it exists for. Measured: it did.
     */
    const contained = await report(security, { detectedAt: hoursAgo(6) });
    for (const [url, payload] of [
      ['/triage', { assignedTo: FIXTURE.SECURITY.id }],
      ['/contain', { containedAt: hoursAgo(5) }],
    ] as const) {
      const step = await apiRequest(
        app,
        security,
        'POST',
        `/incidents/${contained.id}${url}`,
        payload,
      );
      expect(step.status, `${url}: ${JSON.stringify(step.body)}`).toBe(200);
    }

    // EARLIER IS THE LEGITIMATE CORRECTION, and the one this route exists for: somebody finds the alert
    // in a log and realises it fired hours before anybody noticed. It also moves the breach deadline,
    // which is why it must be possible rather than blocked along with the mistakes.
    const earlier = await apiRequest(app, security, 'PATCH', `/incidents/${contained.id}`, {
      detectedAt: hoursAgo(9),
    });
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
    expect(new Date(unwrap<IncidentRow>(earlier.body).detectedAt).getTime()).toBeLessThan(
      new Date(contained.detectedAt).getTime(),
    );

    /*
     * FORWARD PAST THE CONTAINMENT IS REFUSED, and the refusal has to come from the service: the row
     * would violate `ck_incident_timeline_order`, which arrives as a 500 with no code and nothing a
     * responder can act on. The message NAMES the timestamp that blocks it, which is why the form does
     * not pre-empt this with a rule of its own — a client-side guard could only grey the field out,
     * while this says which recorded moment the new one collides with.
     */
    const past = await apiRequest(app, security, 'PATCH', `/incidents/${contained.id}`, {
      detectedAt: hoursAgo(2),
    });
    expect(past.status, JSON.stringify(past.body)).toBe(412);
    expect(errorCode(past.body)).toBe('INCIDENT_TIMELINE_ORDER');
    expect((past.body as { error?: { message?: string } }).error?.message).toContain('contained');

    // And a correction cannot claim the incident was noticed tomorrow. An hour, not seconds: the
    // tolerance is two minutes and a test sitting on that boundary measures the environment's clocks
    // rather than the rule — see the skew case in `reporting`.
    const future = await apiRequest(app, security, 'PATCH', `/incidents/${contained.id}`, {
      detectedAt: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(future.status).toBe(412);
    expect(errorCode(future.body)).toBe('INCIDENT_TIMELINE_ORDER');
  });

  it('links the risk it realised and the device it happened on, and lets both be removed', async () => {
    /*
     * THE FEEDBACK LOOP, and the gap that made it unusable: both ids are in the schema and were in no
     * form, so an incident could never be traced to the risk it realised — while
     * `/incidents/unlinked-to-risk` sat there listing everything, with no way to act on the list.
     *
     * REMOVAL MATTERS AS MUCH AS LINKING. A link to the wrong risk is the same class of mistake as a
     * mis-graded severity, so `null` has to clear the field rather than being treated as "unchanged" —
     * otherwise the first wrong choice is permanent, which is the very thing this route exists to fix.
     */
    const incident = await report();

    const risk = await apiRequest(app, security, 'POST', '/risks', {
      reference: `E2E-INC-CR-${RUN}-${++seq}`,
      title: 'Credential harvesting via spoofed vendor mail',
      description: 'Staff may enter credentials on a convincing fake portal.',
      category: 'phishing',
      ownerId: FIXTURE.SECURITY.id,
      inherent: { likelihood: 4, impact: 3 },
    });
    expect(risk.status, JSON.stringify(risk.body)).toBe(201);
    const riskId = unwrap<{ id: string }>(risk.body).id;

    const asset = await apiRequest(app, admin, 'POST', '/assets', {
      assetTag: `E2E-INC-A-${RUN}-${++seq}`,
      type: 'laptop',
      manufacturer: 'Acme',
      model: 'Book 13',
      status: 'in_stock',
    });
    expect(asset.status, JSON.stringify(asset.body)).toBe(201);
    const assetId = unwrap<{ id: string }>(asset.body).id;

    const linked = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      riskId,
      assetId,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(unwrap<IncidentRow>(linked.body).riskId).toBe(riskId);
    expect(unwrap<IncidentRow>(linked.body).assetId).toBe(assetId);

    const cleared = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      riskId: null,
      assetId: null,
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(unwrap<IncidentRow>(cleared.body).riskId).toBeNull();
    expect(unwrap<IncidentRow>(cleared.body).assetId).toBeNull();
    // Back on the "no risk linked" report, which is the queue somebody works through.
    expect(
      unwrap<IncidentRow[]>(
        (await apiRequest(app, security, 'GET', '/incidents/unlinked-to-risk')).body,
      ).map((i) => i.id),
    ).toContain(incident.id);
  });

  it('needs at least one field, and refuses a reader who can see the form is missing', async () => {
    const incident = await report();

    // `UpdateIncidentSchema` refines on a non-empty object: an empty correction is a request that means
    // nothing, and answering 200 to it would report success for a change nobody made.
    expect((await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {})).status).toBe(
      422,
    );

    // THE BUTTON BEING HIDDEN IS NOT THE ENFORCEMENT. The screen draws Correct only for
    // `incident.manage`, and an auditor holding `incident.read` can reach the route regardless.
    const auditorAttempt = await apiRequest(app, auditor, 'PATCH', `/incidents/${incident.id}`, {
      severity: 'low',
    });
    expect(auditorAttempt.status).toBe(403);
  });
});

describe('authorization', () => {
  it('lets an incident.read holder read but not handle', async () => {
    const incident = await report();

    expect((await apiRequest(app, auditor, 'GET', '/incidents')).status).toBe(200);
    expect((await apiRequest(app, auditor, 'GET', `/incidents/${incident.id}`)).status).toBe(200);
    expect(
      (await apiRequest(app, auditor, 'GET', `/incidents/${incident.id}/timeline`)).status,
    ).toBe(200);
    expect((await apiRequest(app, auditor, 'GET', '/incidents/breaches/overdue')).status).toBe(200);

    expect(
      (
        await apiRequest(app, auditor, 'POST', `/incidents/${incident.id}/triage`, {
          assignedTo: FIXTURE.SECURITY.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await apiRequest(app, auditor, 'POST', `/incidents/${incident.id}/timeline`, {
          type: 'note',
          detail: 'An auditor may read the timeline but not write to it.',
        })
      ).status,
    ).toBe(403);
  });

  it('refuses reading to a caller holding nothing, while still allowing reporting', async () => {
    const incident = await report(employee);

    // They reported it and still cannot read the register — reporting is the only door open.
    expect((await apiRequest(app, employee, 'GET', '/incidents')).status).toBe(403);
    expect((await apiRequest(app, employee, 'GET', `/incidents/${incident.id}`)).status).toBe(403);
    expect(
      (await apiRequest(app, employee, 'GET', `/incidents/${incident.id}/timeline`)).status,
    ).toBe(403);
  });
});

describe('unknown ids', () => {
  it('404s rather than answering emptily', async () => {
    const missing = '00000000-0000-7000-8000-0000000000ff';
    expect((await apiRequest(app, security, 'GET', `/incidents/${missing}`)).status).toBe(404);
    expect((await apiRequest(app, security, 'GET', `/incidents/${missing}/timeline`)).status).toBe(
      404,
    );
    expect(
      (await apiRequest(app, security, 'POST', `/incidents/${missing}/contain`, {})).status,
    ).toBe(404);
  });
});

/**
 * IncidentService — the state machine, the timeline written by the transition, and the breach clock.
 *
 * WHY UNIT TESTS WHEN THERE IS AN E2E SUITE. `isms-incidents.e2e.spec.ts` drives the real API, the
 * six CHECKs and the overdue SQL. What it cannot reach cheaply is the ORDER and the ARGUMENTS: that a
 * status change appends its timeline entry in the SAME transaction and with the same timestamp it
 * recorded, that the guarded `WHERE status = <from>` is what a lost race reports, and that each
 * transition refuses before any write.
 *
 * The repository, the transaction and the audit are stubs, so what is under test is this service's
 * decisions.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, type DrizzleDB } from '@platform';
import { REPORT_ROW_LIMIT } from '@shared-kernel';
import { BREACH_NOTIFICATION_HOURS, IncidentService } from './incident.service';
import type { Incident, IncidentEvent } from '../domain/incident.types';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

const ACTOR = { sub: 'actor-1', email: 'actor@opshub.local' };
const DETECTED = new Date('2026-03-01T02:00:00.000Z');
const CAUSE = 'A spoofed vendor email harvested one credential; MFA blocked the login.';
const LESSON = 'Block the spoofed domain at the gateway and re-run awareness training.';

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    reference: 'INC-2026-004',
    title: 'Phishing email reported by staff',
    description: 'A member of staff clicked a credential-harvesting link.',
    category: 'phishing',
    severity: 'high',
    status: 'reported',
    detectedAt: DETECTED,
    reportedBy: 'reporter-1',
    assignedTo: null,
    containedAt: null,
    resolvedAt: null,
    closedAt: null,
    rootCause: null,
    lessonsLearned: null,
    assetId: null,
    riskId: null,
    personalDataBreach: false,
    regulatorNotifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function event(over: Partial<IncidentEvent> = {}): IncidentEvent {
  return {
    id: 'evt-1',
    incidentId: 'inc-1',
    type: 'note',
    detail: 'Something happened',
    recordedBy: ACTOR.sub,
    occurredAt: DETECTED,
    createdAt: new Date(),
    ...over,
  };
}

function makeService(over: Record<string, unknown> = {}) {
  const repo = {
    create: vi.fn().mockResolvedValue(incident()),
    findById: vi.fn().mockResolvedValue(incident()),
    findByReference: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    update: vi
      .fn()
      .mockImplementation((id: string, input: Partial<Incident>) =>
        Promise.resolve(incident({ id, ...input })),
      ),
    transition: vi
      .fn()
      .mockImplementation(
        (id: string, _f: string, to: Incident['status'], extra: Partial<Incident>) =>
          Promise.resolve(incident({ id, status: to, ...extra })),
      ),
    markRegulatorNotified: vi
      .fn()
      .mockImplementation((id: string, at: Date) =>
        Promise.resolve(incident({ id, personalDataBreach: true, regulatorNotifiedAt: at })),
      ),
    appendEvent: vi
      .fn()
      .mockImplementation((incidentId: string, input: Record<string, unknown>) =>
        Promise.resolve(event({ incidentId, ...(input as Partial<IncidentEvent>) })),
      ),
    listEvents: vi.fn().mockResolvedValue([]),
    // The reference guards default to "it resolves", so a test that says nothing about them is
    // testing the rest of the patch rather than silently exercising a refusal.
    riskExists: vi.fn().mockResolvedValue(true),
    assetExists: vi.fn().mockResolvedValue(true),
    overdueBreaches: vi.fn().mockResolvedValue([]),
    unlinkedToRisk: vi.fn().mockResolvedValue([]),
    ...over,
  };
  const TX = { tx: true };
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  const db = { transaction } as unknown as DrizzleDB;
  const audit = createFakeAudit();

  const service = new IncidentService(repo, db, audit as never);
  return { service, repo, transaction, audit, TX };
}

/**
 * The refusal a call produced, so its CODE, STATUS and MESSAGE can each be asserted.
 *
 * `rejects.toMatchObject` is the house style and stays that way for a code-only assertion. It is the
 * wrong tool for a message: `Error.message` is a non-enumerable own property, so what a subset match
 * does with it depends on the matcher's internals rather than on the message. These refusals are
 * remediation instructions — "record it as a timeline entry", "riskId <uuid>" — and a test that
 * cannot see the text cannot pin the part a caller reads. It also FAILS on a success, so a guard
 * that stopped throwing cannot pass as "no message to check".
 */
async function refusalOf(
  call: Promise<unknown>,
): Promise<Error & { code?: string; httpStatus?: number }> {
  const outcome = await call.then(
    () => null,
    (thrown: Error & { code?: string; httpStatus?: number }) => thrown,
  );
  if (!outcome) throw new Error('expected the call to be refused, and it resolved');
  return outcome;
}

/** A `reported` incident staged at the given status with the timestamps it must have passed. */
function at(status: Incident['status']): Partial<Incident> {
  const contained = new Date(DETECTED.getTime() + 3_600_000);
  const resolved = new Date(contained.getTime() + 3_600_000);
  switch (status) {
    case 'triaged':
      return { status, assignedTo: 'responder-1' };
    case 'contained':
      return { status, assignedTo: 'responder-1', containedAt: contained };
    case 'resolved':
      return { status, containedAt: contained, resolvedAt: resolved, rootCause: CAUSE };
    default:
      return { status };
  }
}

describe('reportIncident', () => {
  it('refuses a duplicate reference before writing anything', async () => {
    const { service, repo } = makeService({
      findByReference: vi.fn().mockResolvedValue(incident()),
    });

    await expect(
      service.reportIncident(
        {
          reference: 'INC-2026-004',
          title: 'X',
          description: 'Y',
          category: 'phishing',
          severity: 'low',
          detectedAt: DETECTED.toISOString(),
        },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses a detection in the future', async () => {
    const { service, repo } = makeService();

    await expect(
      service.reportIncident(
        {
          reference: 'INC-9',
          title: 'X',
          description: 'Y',
          category: 'phishing',
          severity: 'low',
          detectedAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'INCIDENT_TIMELINE_ORDER' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('opens the timeline at the DETECTION time, not now', async () => {
    // A timeline that starts when the form was filled loses the gap between detection and reporting,
    // which is the first thing a post-incident review looks at.
    const { service, repo, TX } = makeService();

    await service.reportIncident(
      {
        reference: 'INC-9',
        title: 'X',
        description: 'Y',
        category: 'phishing',
        severity: 'low',
        detectedAt: DETECTED.toISOString(),
      },
      ACTOR,
    );

    expect(repo.appendEvent).toHaveBeenCalledWith(
      'inc-1',
      expect.objectContaining({ type: 'status_change', occurredAt: DETECTED }),
      TX,
    );
  });

  it('records the reporter from the token', async () => {
    // `ReportIncidentInput` has no `reportedBy`, so a caller cannot even express the smuggle — the
    // type is the first guarantee. What this pins is the second: the service supplies it from the
    // actor rather than leaving it to the repository's default or to a later caller.
    const { service, repo } = makeService();

    await service.reportIncident(
      {
        reference: 'INC-9',
        title: 'X',
        description: 'Y',
        category: 'phishing',
        severity: 'low',
        detectedAt: DETECTED.toISOString(),
      },
      ACTOR,
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ reportedBy: ACTOR.sub }),
      expect.anything(),
    );
  });
});

describe('the state machine', () => {
  it('refuses every skipped step', async () => {
    const cases: [Incident['status'], () => Promise<unknown>][] = [];
    const build = (status: Incident['status']) =>
      makeService({ findById: vi.fn().mockResolvedValue(incident(at(status))) });

    // reported cannot contain, resolve or close
    for (const move of ['contain', 'resolve', 'close'] as const) {
      const { service } = build('reported');
      cases.push([
        'reported',
        () =>
          move === 'contain'
            ? service.contain('inc-1', undefined, ACTOR)
            : move === 'resolve'
              ? service.resolve('inc-1', { rootCause: CAUSE }, ACTOR)
              : service.close('inc-1', { lessonsLearned: LESSON }, ACTOR),
      ]);
    }
    // triaged cannot resolve; contained cannot close
    const triaged = build('triaged');
    cases.push(['triaged', () => triaged.service.resolve('inc-1', { rootCause: CAUSE }, ACTOR)]);
    const contained = build('contained');
    cases.push([
      'contained',
      () => contained.service.close('inc-1', { lessonsLearned: LESSON }, ACTOR),
    ]);

    for (const [from, run] of cases) {
      await expect(run(), `from ${from}`).rejects.toMatchObject({
        code: 'INCIDENT_NOT_IN_STATE',
      });
    }
  });

  it('refuses to dismiss anything already contained', async () => {
    // Once contained it demonstrably WAS an incident, and `ck_incident_false_positive` refuses the
    // handling timestamps a later dismissal would leave behind.
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(incident(at('contained'))),
    });

    await expect(
      service.dismiss('inc-1', 'A test message after all.', ACTOR),
    ).rejects.toMatchObject({ code: 'INCIDENT_NOT_IN_STATE' });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('allows dismissal from reported and triaged', async () => {
    for (const status of ['reported', 'triaged'] as const) {
      const { service } = makeService({
        findById: vi.fn().mockResolvedValue(incident(at(status))),
      });
      await expect(
        service.dismiss('inc-1', 'It was a scheduled penetration test.', ACTOR),
      ).resolves.toMatchObject({ status: 'false_positive' });
    }
  });

  it('reports a lost race as a conflict, not a precondition failure', async () => {
    // The guarded WHERE returning nothing means another responder moved it — a genuine concurrent
    // edit, which is the normal case during an incident rather than the edge case.
    const { service } = makeService({
      findById: vi.fn().mockResolvedValue(incident(at('triaged'))),
      transition: vi.fn().mockResolvedValue(null),
    });

    await expect(service.contain('inc-1', undefined, ACTOR)).rejects.toThrow(ConflictException);
  });
});

describe('the timeline is written by the transition', () => {
  it('appends a status_change in the same transaction, with the recorded timestamp', async () => {
    const containedAt = new Date(DETECTED.getTime() + 7_200_000);
    const { service, repo, TX } = makeService({
      findById: vi.fn().mockResolvedValue(incident(at('triaged'))),
    });

    await service.contain('inc-1', containedAt.toISOString(), ACTOR);

    // Same timestamp on the column and on the timeline: a review comparing the two must not find
    // them disagreeing by however long the request took.
    expect(repo.transition).toHaveBeenCalledWith(
      'inc-1',
      'triaged',
      'contained',
      { containedAt },
      TX,
    );
    expect(repo.appendEvent).toHaveBeenCalledWith(
      'inc-1',
      expect.objectContaining({ type: 'status_change', occurredAt: containedAt }),
      TX,
    );
  });

  it('does not append anything when the transition is refused', async () => {
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(incident(at('reported'))),
    });

    await expect(service.resolve('inc-1', { rootCause: CAUSE }, ACTOR)).rejects.toMatchObject({
      code: 'INCIDENT_NOT_IN_STATE',
    });
    expect(repo.appendEvent).not.toHaveBeenCalled();
  });

  it('refuses a timeline entry dated before detection', async () => {
    const { service, repo } = makeService();

    await expect(
      service.recordEvent(
        'inc-1',
        {
          type: 'note',
          detail: 'Recorded against the wrong day',
          occurredAt: new Date(DETECTED.getTime() - 3_600_000).toISOString(),
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'INCIDENT_TIMELINE_ORDER' });
    expect(repo.appendEvent).not.toHaveBeenCalled();
  });

  it('allows a timeline entry on a CLOSED incident', async () => {
    // A post-incident review adds to the record after closure; refusing it would push the analysis
    // somewhere the audit trail cannot see.
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(
        incident({
          ...at('resolved'),
          status: 'closed',
          closedAt: new Date(DETECTED.getTime() + 10_800_000),
          lessonsLearned: LESSON,
        }),
      ),
    });

    await expect(
      service.recordEvent('inc-1', { type: 'note', detail: 'Review completed' }, ACTOR),
    ).resolves.toBeTruthy();
    expect(repo.appendEvent).toHaveBeenCalled();
  });
});

describe('evidence requirements', () => {
  it('refuses a thin root cause and a thin lesson', async () => {
    const resolved = makeService({
      findById: vi.fn().mockResolvedValue(incident(at('contained'))),
    });
    await expect(
      resolved.service.resolve('inc-1', { rootCause: 'unknown' }, ACTOR),
    ).rejects.toMatchObject({ code: 'INCIDENT_EVIDENCE_MISSING' });
    expect(resolved.repo.transition).not.toHaveBeenCalled();

    const closed = makeService({ findById: vi.fn().mockResolvedValue(incident(at('resolved'))) });
    await expect(
      closed.service.close('inc-1', { lessonsLearned: 'none' }, ACTOR),
    ).rejects.toMatchObject({ code: 'INCIDENT_EVIDENCE_MISSING' });
    expect(closed.repo.transition).not.toHaveBeenCalled();
  });

  it('refuses resolution dated before containment', async () => {
    const { service } = makeService({
      findById: vi.fn().mockResolvedValue(incident(at('contained'))),
    });

    await expect(
      service.resolve('inc-1', { rootCause: CAUSE, resolvedAt: DETECTED.toISOString() }, ACTOR),
    ).rejects.toMatchObject({ code: 'INCIDENT_TIMELINE_ORDER' });
  });
});

describe('updateIncident', () => {
  it('refuses to change a finished incident', async () => {
    for (const status of ['closed', 'false_positive'] as const) {
      const { service, repo } = makeService({
        findById: vi
          .fn()
          .mockResolvedValue(
            incident(
              status === 'closed'
                ? { ...at('resolved'), status, closedAt: new Date(), lessonsLearned: LESSON }
                : { status },
            ),
          ),
      });
      await expect(
        service.updateIncident('inc-1', { severity: 'low' }, ACTOR),
      ).rejects.toMatchObject({ code: 'INCIDENT_NOT_IN_STATE' });
      expect(repo.update).not.toHaveBeenCalled();
    }
  });

  it('refuses moving detection past a recorded containment', async () => {
    // `ck_incident_timeline_order` compares against what is already there, so this would otherwise
    // arrive as a 500 with no code.
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(incident(at('contained'))),
    });

    await expect(
      service.updateIncident(
        'inc-1',
        { detectedAt: new Date(DETECTED.getTime() + 7_200_000).toISOString() },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'INCIDENT_TIMELINE_ORDER' });
    expect(repo.update).not.toHaveBeenCalled();
  });
});

/**
 * A regulator notification cannot be un-said.
 *
 * The row this refusal prevents denies being a personal-data breach while carrying the timestamp
 * proving one was reported — and neither half can be put back: `markRegulatorNotified` matches only
 * an un-notified breach, and there is no un-notify route. It also drops out of the overdue-breach
 * report, which filters on that same pair.
 *
 * `ck_incident_breach_notification_pair` refuses the row as well; that half needs a real database and
 * is asserted in the e2e suite. These pin the ANSWER — a 412 with a code and a way out, rather than
 * the CHECK violation's 500.
 */
describe('retracting a notified breach', () => {
  const notified = () =>
    incident({
      personalDataBreach: true,
      regulatorNotifiedAt: new Date('2026-03-02T09:00:00.000Z'),
    });

  it('refuses clearing personalDataBreach once the regulator has been notified', async () => {
    const { service, repo } = makeService({ findById: vi.fn().mockResolvedValue(notified()) });

    await expect(
      service.updateIncident('inc-1', { personalDataBreach: false }, ACTOR),
    ).rejects.toMatchObject({ code: 'INCIDENT_BREACH_NOTIFIED' });
    // Before the write, not after: the update is unconditional on id, so a refusal that arrived
    // later would already have cleared the flag.
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('names the notification date and what to do instead', async () => {
    // The message is the whole remediation. A bare "precondition failed" leaves a responder who has
    // just reassessed the incident with no legal next action.
    const { service } = makeService({ findById: vi.fn().mockResolvedValue(notified()) });

    const error = await refusalOf(
      service.updateIncident('inc-1', { personalDataBreach: false }, ACTOR),
    );

    expect(error.message).toContain('2026-03-02T09:00:00.000Z');
    expect(error.message).toContain('timeline entry');
  });

  it('still allows clearing it when no regulator was notified', async () => {
    // The correction the flag exists for: an incident first logged as a breach and then reassessed,
    // before anybody filed anything. Refusing this would be a worse bug than the one being fixed.
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(incident({ personalDataBreach: true })),
    });

    await expect(
      service.updateIncident('inc-1', { personalDataBreach: false }, ACTOR),
    ).resolves.toMatchObject({ personalDataBreach: false });
    expect(repo.update).toHaveBeenCalledWith(
      'inc-1',
      { personalDataBreach: false },
      expect.anything(),
    );
  });

  it('still allows marking it as a breach after a notification exists', async () => {
    // Setting the flag adds an obligation; only clearing it erases the evidence one was met.
    const { service, repo } = makeService({ findById: vi.fn().mockResolvedValue(notified()) });

    await expect(
      service.updateIncident('inc-1', { personalDataBreach: true }, ACTOR),
    ).resolves.toBeTruthy();
    expect(repo.update).toHaveBeenCalled();
  });

  it('leaves a patch that never mentions the flag alone', async () => {
    // Pins `=== false` rather than a falsy test: an absent field is not a retraction, and reading it
    // as one would refuse every severity correction on every notified breach.
    const { service, repo } = makeService({ findById: vi.fn().mockResolvedValue(notified()) });

    await expect(service.updateIncident('inc-1', { severity: 'low' }, ACTOR)).resolves.toBeTruthy();
    expect(repo.update).toHaveBeenCalled();
  });
});

/**
 * `riskId` and `assetId` name rows in other tables, and both columns carry a foreign key.
 *
 * So the database already refuses a dangling reference — as SQLSTATE 23503, which reached the caller
 * as `500 INTERNAL_ERROR` with no indication of which field was wrong. These pin the restatement.
 */
describe('references that name nothing', () => {
  const RISK = '00000000-0000-4000-8000-000000000999';
  const ASSET = '00000000-0000-4000-8000-000000000aaa';

  it('refuses an unknown riskId as a 404 that names the field', async () => {
    const { service, repo } = makeService({ riskExists: vi.fn().mockResolvedValue(false) });

    const error = await refusalOf(service.updateIncident('inc-1', { riskId: RISK }, ACTOR));

    // 404 and not 500 is the defect; `riskId` in the message is what makes the 404 actionable.
    expect(error.code).toBe('NOT_FOUND');
    expect(error.httpStatus).toBe(404);
    expect(error.message).toContain(`riskId ${RISK}`);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('refuses an unknown assetId as a 404 that names the field', async () => {
    const { service, repo } = makeService({ assetExists: vi.fn().mockResolvedValue(false) });

    const error = await refusalOf(service.updateIncident('inc-1', { assetId: ASSET }, ACTOR));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.httpStatus).toBe(404);
    expect(error.message).toContain(`assetId ${ASSET}`);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('reports BOTH bad references in one refusal', async () => {
    // Told about one, the caller fixes it, resubmits and is told about the other. That round trip is
    // why `assertExist` resolves every id before throwing, and why this does the same.
    const { service } = makeService({
      riskExists: vi.fn().mockResolvedValue(false),
      assetExists: vi.fn().mockResolvedValue(false),
    });

    const error = await refusalOf(
      service.updateIncident('inc-1', { riskId: RISK, assetId: ASSET }, ACTOR),
    );

    expect(error.message).toContain(`riskId ${RISK}`);
    expect(error.message).toContain(`assetId ${ASSET}`);
  });

  it('accepts references that resolve', async () => {
    const { service, repo } = makeService();

    await expect(
      service.updateIncident('inc-1', { riskId: RISK, assetId: ASSET }, ACTOR),
    ).resolves.toMatchObject({ riskId: RISK, assetId: ASSET });
    expect(repo.riskExists).toHaveBeenCalledWith(RISK);
    expect(repo.assetExists).toHaveBeenCalledWith(ASSET);
  });

  it('asks nothing when the reference is unchanged or being cleared', async () => {
    // What is stored already satisfies the foreign key, and a null is an UNLINK — neither has a
    // target to resolve, so neither is worth a round trip.
    const echoed = makeService({ findById: vi.fn().mockResolvedValue(incident({ riskId: RISK })) });
    await expect(
      echoed.service.updateIncident('inc-1', { riskId: RISK }, ACTOR),
    ).resolves.toBeTruthy();
    expect(echoed.repo.riskExists).not.toHaveBeenCalled();

    const cleared = makeService({
      findById: vi.fn().mockResolvedValue(incident({ riskId: RISK })),
    });
    await expect(
      cleared.service.updateIncident('inc-1', { riskId: null, assetId: null }, ACTOR),
    ).resolves.toBeTruthy();
    expect(cleared.repo.riskExists).not.toHaveBeenCalled();
    expect(cleared.repo.assetExists).not.toHaveBeenCalled();
    expect(cleared.repo.update).toHaveBeenCalledWith(
      'inc-1',
      { riskId: null, assetId: null },
      expect.anything(),
    );
  });
});

describe('breach notification', () => {
  it('refuses an incident that is not a personal-data breach', async () => {
    const { service, repo } = makeService();

    await expect(
      service.recordRegulatorNotification('inc-1', undefined, ACTOR),
    ).rejects.toMatchObject({ code: 'INCIDENT_NOT_A_BREACH' });
    expect(repo.markRegulatorNotified).not.toHaveBeenCalled();
  });

  it('reports an already-notified breach as a conflict', async () => {
    // The repository's WHERE clause is un-notified-only, so a null means somebody recorded it first.
    // Overwriting would erase whether the 72 hours were met.
    const { service } = makeService({
      findById: vi.fn().mockResolvedValue(incident({ personalDataBreach: true })),
      markRegulatorNotified: vi.fn().mockResolvedValue(null),
    });

    await expect(service.recordRegulatorNotification('inc-1', undefined, ACTOR)).rejects.toThrow(
      ConflictException,
    );
  });

  it('puts the notification on the timeline as well as the column', async () => {
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(incident({ personalDataBreach: true })),
    });

    await service.recordRegulatorNotification('inc-1', undefined, ACTOR);

    // The column is what the overdue report queries; the timeline is what a reviewer reads.
    expect(repo.markRegulatorNotified).toHaveBeenCalled();
    expect(repo.appendEvent).toHaveBeenCalledWith(
      'inc-1',
      expect.objectContaining({ type: 'notification' }),
      expect.anything(),
    );
  });

  it('states the 72-hour window once', () => {
    // The constant the controller derives `notificationDueAt` from and the repository's SQL agree on
    // one number; a second literal is how they drift.
    expect(BREACH_NOTIFICATION_HOURS).toBe(72);
  });
});

describe('reports', () => {
  it('caps both reports at the shared report ceiling', async () => {
    // The CONSTANT, not the number it currently holds: these two used their own undocumented 100, so a
    // reader could not tell whether it meant anything. Asserting the constant is what keeps this test
    // about "reports share one ceiling" rather than about the value 200.
    const { service, repo } = makeService();

    await service.overdueBreaches();
    await service.unlinkedToRisk();

    expect(repo.overdueBreaches).toHaveBeenCalledWith(REPORT_ROW_LIMIT);
    expect(repo.unlinkedToRisk).toHaveBeenCalledWith(REPORT_ROW_LIMIT);
  });
});

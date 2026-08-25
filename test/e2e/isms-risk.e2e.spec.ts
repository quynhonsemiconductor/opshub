/**
 * ISMS risk register, end to end: scoring, the lifecycle, and acceptance through the request engine.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - SCORES ARE GENERATED COLUMNS. `inherent_score` and `residual_score` come back computed by
 *     Postgres, and no API accepts one. Only a real database can prove that.
 *   - RESIDUAL CANNOT EXCEED INHERENT (`ck_risk_residual_not_worse`), refused with a CODE rather
 *     than the 500 a bare constraint violation produces
 *   - a risk cannot be declared TREATED while treatment actions are open
 *   - ACCEPTANCE BRANCHES ON THE THRESHOLD: below it the acceptance is recorded directly; at or
 *     above it a `risk_acceptance` request is submitted, the risk is left untouched, and only an
 *     approval by somebody holding `risk.accept` — who is not the assessor — moves it
 *   - the evidence a CHECK demands travels together: who accepted, when, and why
 *   - `risk.read` is not `risk.manage`, and neither is `risk.accept`
 *
 * SEPARATION OF DUTIES IS THE POINT OF THE THRESHOLD TEST. `SECURITY` holds `risk.manage` and NOT
 * `risk.accept`; `ADMIN` holds everything. So the assessor submits and the admin approves, which is
 * the arrangement ISO 27001 asks for and the reason acceptance is a request rather than a field.
 *
 * REFERENCES ARE UNIQUE PER RUN. `uq_risk_reference` is global and the database is shared with the
 * other suites and not reset between them, so a fixed reference makes a spec that passes once.
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
/** Holds `risk.read` + `risk.manage`, and NOT `risk.accept` — the assessor. */
let security: Session;
/** Holds everything, including `risk.accept` — the approver, and a different person. */
let admin: Session;
/** Holds `risk.read` only. */
let auditor: Session;
/** Holds no permission codes at all. */
let employee: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextRef = (): string => `RSK-${RUN}-${++seq}`;

/** Mirrors `ACCEPTANCE_APPROVAL_THRESHOLD` in the service — 12 on a 5x5 matrix. */
const THRESHOLD = 12;

interface RiskRow {
  id: string;
  reference: string;
  ownerId: string;
  ownerName: string | null;
  inherentLikelihood: number;
  inherentImpact: number;
  inherentScore: number | null;
  residualLikelihood: number | null;
  residualImpact: number | null;
  residualScore: number | null;
  treatmentDecision: string | null;
  status: string;
  reviewDueOn: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  acceptanceJustification: string | null;
  acceptedViaRequestId: string | null;
  closureNote: string | null;
}
interface TreatmentRow {
  id: string;
  status: string;
  completedOn: string | null;
}
interface AcceptResponse {
  risk: RiskRow;
  requestId: string | null;
}

/** A risk with the given inherent factors, owned by the security fixture. */
async function identify(likelihood: number, impact: number): Promise<RiskRow> {
  const res = await apiRequest(app, security, 'POST', '/risks', {
    reference: nextRef(),
    title: 'Unpatched perimeter device',
    description: 'A device on the network edge is missing vendor security updates.',
    category: 'vulnerability',
    ownerId: FIXTURE.SECURITY.id,
    inherent: { likelihood, impact },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<RiskRow>(res.body);
}

/** Identify and assess, so the risk carries a residual score of `rl × ri`. */
async function assessed(
  inherent: [number, number],
  residual: [number, number],
  decision = 'mitigate',
): Promise<RiskRow> {
  const risk = await identify(inherent[0], inherent[1]);
  const res = await apiRequest(app, security, 'POST', `/risks/${risk.id}/assess`, {
    decision,
    residual: { likelihood: residual[0], impact: residual[1] },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return unwrap<RiskRow>(res.body);
}

beforeAll(async () => {
  app = await createTestApp();
  security = await login(app, FIXTURE.SECURITY);
  admin = await login(app, FIXTURE.ADMIN);
  auditor = await login(app, FIXTURE.AUDITOR);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('scoring', () => {
  it('computes the inherent score in the database, and accepts no score from the caller', async () => {
    const risk = await identify(4, 4);
    expect(risk.inherentScore).toBe(16);

    // The API surface has no score field: sending one is ignored rather than honoured, so a row can
    // never disagree with its own factors.
    const withScore = await apiRequest(app, security, 'POST', '/risks', {
      reference: nextRef(),
      title: 'Score smuggling',
      description: 'Attempts to set the score directly.',
      category: 'vulnerability',
      ownerId: FIXTURE.SECURITY.id,
      inherent: { likelihood: 1, impact: 1 },
      inherentScore: 25,
    });
    expect(withScore.status).toBe(201);
    expect(unwrap<RiskRow>(withScore.body).inherentScore).toBe(1);
  });

  it('rejects a factor outside 1..5', async () => {
    for (const inherent of [
      { likelihood: 0, impact: 3 },
      { likelihood: 6, impact: 3 },
      { likelihood: 3, impact: 9 },
    ]) {
      const res = await apiRequest(app, security, 'POST', '/risks', {
        reference: nextRef(),
        title: 'Out of range',
        description: 'A factor outside the 5x5 matrix.',
        category: 'vulnerability',
        ownerId: FIXTURE.SECURITY.id,
        inherent,
      });
      expect(res.status, JSON.stringify(inherent)).toBe(422);
    }
  });

  it('refuses a duplicate reference, and an owner who does not exist', async () => {
    const reference = nextRef();
    const first = await apiRequest(app, security, 'POST', '/risks', {
      reference,
      title: 'First',
      description: 'The first risk with this reference.',
      category: 'vulnerability',
      ownerId: FIXTURE.SECURITY.id,
      inherent: { likelihood: 2, impact: 2 },
    });
    expect(first.status).toBe(201);

    const dup = await apiRequest(app, security, 'POST', '/risks', {
      reference,
      title: 'Second',
      description: 'The same reference again.',
      category: 'vulnerability',
      ownerId: FIXTURE.SECURITY.id,
      inherent: { likelihood: 2, impact: 2 },
    });
    expect(dup.status).toBe(409);

    // `owner_id` carries no cross-schema FK, so without the controller's check a typo would become a
    // risk owned by nobody.
    const nobody = await apiRequest(app, security, 'POST', '/risks', {
      reference: nextRef(),
      title: 'Ownerless',
      description: 'An owner id that does not resolve.',
      category: 'vulnerability',
      ownerId: '00000000-0000-7000-8000-0000000000fe',
      inherent: { likelihood: 2, impact: 2 },
    });
    expect(nobody.status).toBe(404);
  });
});

describe('assessment', () => {
  it('records the decision and computes the residual score', async () => {
    const risk = await assessed([4, 4], [2, 2]);
    expect(risk.status).toBe('assessed');
    expect(risk.treatmentDecision).toBe('mitigate');
    expect(risk.residualScore).toBe(4);
  });

  it('refuses a residual worse than the inherent score, and allows one equal to it', async () => {
    const risk = await identify(2, 2);

    const worse = await apiRequest(app, security, 'POST', `/risks/${risk.id}/assess`, {
      decision: 'mitigate',
      residual: { likelihood: 3, impact: 3 },
    });
    expect(worse.status).toBe(412);
    expect(errorCode(worse.body)).toBe('RISK_INVALID_SCORE');

    // Equal is legitimate: `transfer` and `accept` leave the score where it is.
    const equal = await apiRequest(app, security, 'POST', `/risks/${risk.id}/assess`, {
      decision: 'transfer',
      residual: { likelihood: 2, impact: 2 },
    });
    expect(equal.status).toBe(200);
    expect(unwrap<RiskRow>(equal.body).residualScore).toBe(4);
  });

  it('refuses to lower the inherent score below a recorded residual', async () => {
    const risk = await assessed([4, 4], [3, 3]);

    const lowered = await apiRequest(app, security, 'PATCH', `/risks/${risk.id}`, {
      inherent: { likelihood: 2, impact: 2 },
    });
    expect(lowered.status).toBe(412);
    expect(errorCode(lowered.body)).toBe('RISK_INVALID_SCORE');
  });
});

describe('treatment', () => {
  it('refuses to mark treated while an action is open, and allows it once done', async () => {
    const risk = await assessed([4, 4], [2, 2]);

    const added = await apiRequest(app, security, 'POST', `/risks/${risk.id}/treatments`, {
      description: 'Patch the device and confirm the version.',
      ownerId: FIXTURE.SECURITY.id,
      dueOn: '2027-01-31',
    });
    expect(added.status).toBe(201);
    const treatment = unwrap<TreatmentRow>(added.body);
    expect(treatment.status).toBe('planned');

    const early = await apiRequest(app, security, 'POST', `/risks/${risk.id}/treated`, {});
    expect(early.status).toBe(412);
    expect(errorCode(early.body)).toBe('RISK_TREATMENT_OUTSTANDING');

    const done = await apiRequest(app, security, 'PATCH', `/risks/treatments/${treatment.id}`, {
      status: 'done',
    });
    expect(done.status).toBe(200);
    // `ck_treatment_done_evidence` pairs `done` with a date, and the service fills today's rather
    // than making the caller send it twice.
    expect(unwrap<TreatmentRow>(done.body).completedOn).not.toBeNull();

    const treated = await apiRequest(app, security, 'POST', `/risks/${risk.id}/treated`, {
      residual: { likelihood: 1, impact: 2 },
    });
    expect(treated.status, JSON.stringify(treated.body)).toBe(200);
    expect(unwrap<RiskRow>(treated.body)).toMatchObject({ status: 'treated', residualScore: 2 });
  });

  it('does not count a CANCELLED action as outstanding', async () => {
    const risk = await assessed([3, 3], [2, 2]);
    const added = await apiRequest(app, security, 'POST', `/risks/${risk.id}/treatments`, {
      description: 'An approach that was abandoned.',
      ownerId: FIXTURE.SECURITY.id,
    });
    const treatment = unwrap<TreatmentRow>(added.body);

    expect(
      (
        await apiRequest(app, security, 'PATCH', `/risks/treatments/${treatment.id}`, {
          status: 'cancelled',
        })
      ).status,
    ).toBe(200);

    // Abandoned work is not outstanding work.
    const treated = await apiRequest(app, security, 'POST', `/risks/${risk.id}/treated`, {});
    expect(treated.status, JSON.stringify(treated.body)).toBe(200);
  });

  it('refuses to mark a risk treated before it has been assessed', async () => {
    const risk = await identify(3, 3);
    const res = await apiRequest(app, security, 'POST', `/risks/${risk.id}/treated`, {});
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('RISK_NOT_IN_STATE');
  });
});

describe('acceptance below the threshold', () => {
  it('records it directly, with who, when and why', async () => {
    // Residual 9 — under 12.
    const risk = await assessed([4, 4], [3, 3]);

    const accepted = await apiRequest(app, security, 'POST', `/risks/${risk.id}/accept`, {
      justification: 'The device is being decommissioned next quarter and is firewalled meanwhile.',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const result = unwrap<AcceptResponse>(accepted.body);

    expect(result.requestId).toBeNull();
    expect(result.risk.status).toBe('accepted');
    // `ck_risk_accepted_evidence` demands all three together.
    expect(result.risk.acceptedBy).toBe(FIXTURE.SECURITY.id);
    expect(result.risk.acceptedAt).not.toBeNull();
    expect(result.risk.acceptanceJustification).toContain('decommissioned');
    // No approval was involved, so there is no request to point at.
    expect(result.risk.acceptedViaRequestId).toBeNull();
  });

  it('refuses to accept a risk with no residual score, or to accept twice', async () => {
    const unassessed = await identify(3, 3);
    const early = await apiRequest(app, security, 'POST', `/risks/${unassessed.id}/accept`, {
      justification: 'Accepting before assessing should not be possible.',
    });
    expect(early.status).toBe(412);
    expect(errorCode(early.body)).toBe('RISK_NOT_IN_STATE');

    const risk = await assessed([3, 3], [2, 2]);
    expect(
      (
        await apiRequest(app, security, 'POST', `/risks/${risk.id}/accept`, {
          justification: 'Accepted once, with a reason long enough to be meaningful.',
        })
      ).status,
    ).toBe(200);
    const twice = await apiRequest(app, security, 'POST', `/risks/${risk.id}/accept`, {
      justification: 'Accepting a second time should be refused.',
    });
    expect(twice.status).toBe(412);
  });

  it('requires a justification of substance', async () => {
    const risk = await assessed([3, 3], [2, 2]);
    const thin = await apiRequest(app, security, 'POST', `/risks/${risk.id}/accept`, {
      justification: 'ok',
    });
    expect(thin.status).toBe(422);
  });
});

describe('acceptance at or above the threshold', () => {
  it('submits a request, leaves the risk untouched, and moves it only on approval', async () => {
    // Residual exactly 12 — the boundary.
    const risk = await assessed([5, 5], [4, 3]);
    expect(risk.residualScore).toBe(THRESHOLD);

    const requested = await apiRequest(app, security, 'POST', `/risks/${risk.id}/accept`, {
      justification: 'Compensating controls hold until the platform rebuild completes in Q3.',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const result = unwrap<AcceptResponse>(requested.body);

    expect(result.requestId).not.toBeNull();
    // Nothing is accepted until somebody approves it.
    expect(result.risk.status).toBe('assessed');
    expect(result.risk.acceptedBy).toBeNull();

    const stillOpen = unwrap<RiskRow>(
      (await apiRequest(app, security, 'GET', `/risks/${risk.id}`)).body,
    );
    expect(stillOpen.status).toBe('assessed');

    // The ASSESSOR may not approve their own acceptance: `allowSelfApproval` is false, and they do
    // not hold `risk.accept` either. Both directions matter, so assert the refusal before the
    // approval that works.
    const selfApproval = await apiRequest(
      app,
      security,
      'POST',
      `/requests/${result.requestId!}/approve`,
      {},
    );
    expect(selfApproval.status).toBe(403);

    const approved = await apiRequest(
      app,
      admin,
      'POST',
      `/requests/${result.requestId!}/approve`,
      {},
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const after = unwrap<RiskRow>(
      (await apiRequest(app, security, 'GET', `/risks/${risk.id}`)).body,
    );
    expect(after.status).toBe('accepted');
    // The APPROVER is recorded as accepting it — they are the one carrying the exposure.
    expect(after.acceptedBy).toBe(FIXTURE.ADMIN.id);
    expect(after.acceptanceJustification).toContain('Compensating controls');
    // And the evidence link points at the approval that authorised it.
    expect(after.acceptedViaRequestId).toBe(result.requestId);
  });

  it('leaves the risk where it was when the acceptance is rejected', async () => {
    const risk = await assessed([5, 5], [5, 4]); // residual 20
    const requested = unwrap<AcceptResponse>(
      (
        await apiRequest(app, security, 'POST', `/risks/${risk.id}/accept`, {
          justification: 'Requesting acceptance of a high residual for illustration.',
        })
      ).body,
    );
    expect(requested.requestId).not.toBeNull();

    const rejected = await apiRequest(
      app,
      admin,
      'POST',
      `/requests/${requested.requestId!}/reject`,
      {
        note: 'Treat it — this exposure is not one to carry.',
      },
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    // Never moved at submission, so a refusal leaves it assessed and still open.
    const after = unwrap<RiskRow>(
      (await apiRequest(app, security, 'GET', `/risks/${risk.id}`)).body,
    );
    expect(after.status).toBe('assessed');
    expect(after.acceptedBy).toBeNull();
  });
});

describe('closure', () => {
  it('requires a note, and refuses every later change', async () => {
    const risk = await assessed([3, 3], [2, 2]);

    expect((await apiRequest(app, security, 'POST', `/risks/${risk.id}/close`, {})).status).toBe(
      422,
    );

    const closed = await apiRequest(app, security, 'POST', `/risks/${risk.id}/close`, {
      note: 'The service was decommissioned, so the risk no longer applies.',
    });
    expect(closed.status).toBe(200);
    expect(unwrap<RiskRow>(closed.body)).toMatchObject({ status: 'closed' });
    expect(unwrap<RiskRow>(closed.body).closureNote).toContain('decommissioned');

    // A closed risk is history: no edits, no second closure.
    expect(
      (await apiRequest(app, security, 'PATCH', `/risks/${risk.id}`, { title: 'Rewritten' }))
        .status,
    ).toBe(412);
    expect(
      (
        await apiRequest(app, security, 'POST', `/risks/${risk.id}/close`, {
          note: 'Closing again.',
        })
      ).status,
    ).toBe(412);
  });
});

describe('the register view', () => {
  it('orders worst first and filters by score and review date', async () => {
    const low = await identify(1, 2); // 2
    const high = await identify(5, 5); // 25

    const listed = unwrap<RiskRow[]>(
      (await apiRequest(app, security, 'GET', '/risks?limit=100')).body,
    );
    const positions = [
      listed.findIndex((r) => r.id === high.id),
      listed.findIndex((r) => r.id === low.id),
    ];
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[1]).toBeGreaterThanOrEqual(0);
    // Worst first — the register's whole purpose.
    expect(positions[0]).toBeLessThan(positions[1]);

    const serious = unwrap<RiskRow[]>(
      (await apiRequest(app, security, 'GET', '/risks?minInherentScore=20&limit=100')).body,
    );
    expect(serious.map((r) => r.id)).toContain(high.id);
    expect(serious.map((r) => r.id)).not.toContain(low.id);
  });

  it('gives the review queue for OPEN risks only', async () => {
    const due = await identify(3, 3);
    expect(
      (await apiRequest(app, security, 'PATCH', `/risks/${due.id}`, { reviewDueOn: '2026-01-01' }))
        .status,
    ).toBe(200);

    const queue = () =>
      apiRequest(app, security, 'GET', '/risks?reviewDueOnOrBefore=2026-06-01&limit=100').then(
        (r) => unwrap<RiskRow[]>(r.body).map((x) => x.id),
      );

    expect(await queue()).toContain(due.id);

    expect(
      (
        await apiRequest(app, security, 'POST', `/risks/${due.id}/close`, {
          note: 'No longer applicable.',
        })
      ).status,
    ).toBe(200);

    // A closed risk has no review — it would otherwise sit in the queue forever.
    expect(await queue()).not.toContain(due.id);
  });

  /**
   * `search`, added so the supplier screen's risk picker can be searched BY THE SERVER.
   *
   * The register grows with every risk an organisation records and has no natural ceiling, so a
   * client-side filter over one page would silently stop finding things at the page limit.
   *
   * THE DESCRIPTION IS DELIBERATELY NOT MATCHED, and that is the assertion worth having here. A
   * description is a paragraph; including it makes a two-letter term return most of the register, which
   * is indistinguishable from the filter not working.
   */
  it('searches the reference, title and category — and not the description', async () => {
    const token = `ZQX${RUN}`;
    const reference = nextRef();
    const created = await apiRequest(app, security, 'POST', '/risks', {
      reference,
      title: `Supplier concentration ${token}`,
      // The token appears here too, under a DIFFERENT spelling, so a description match is detectable.
      description: `Only one provider can deliver this service. Internal note ${token}DESC.`,
      category: `third-party-${token}`,
      ownerId: FIXTURE.SECURITY.id,
      inherent: { likelihood: 3, impact: 4 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const risk = unwrap<RiskRow>(created.body);

    const find = (term: string) =>
      apiRequest(app, security, 'GET', `/risks?search=${encodeURIComponent(term)}&limit=100`).then(
        (r) => unwrap<RiskRow[]>(r.body).map((x) => x.id),
      );

    // Title, reference and category all match.
    expect(await find(token)).toContain(risk.id);
    expect(await find(reference)).toContain(risk.id);
    expect(await find(`third-party-${token}`)).toContain(risk.id);
    // Case-insensitive: nobody types a reference in the case it was stored in.
    expect(await find(token.toLowerCase())).toContain(risk.id);

    // The description is NOT searched. `${token}DESC` exists only there.
    expect(await find(`${token}DESC`)).not.toContain(risk.id);

    // And a term that matches nothing returns nothing rather than everything.
    expect(await find(`${token}-no-such-risk`)).toHaveLength(0);
  });
});

describe('naming the owner', () => {
  /*
   * WHY THIS IS ASSERTED AT ALL. The drawer showed `ownerId`, so the one question the register is read
   * for after the score — who is accountable for carrying this exposure — was answered with thirty-six
   * characters that identify nobody, and worse than nobody with uuid v7, whose time prefix makes risks
   * filed in the same sitting look alike. The name has to come from the API rather than the SPA:
   * `GET /v1/employees` needs `employee.read`, which a `risk.read` holder is not required to hold, so
   * resolving it in the browser would hand a 403 and a dash to exactly the roles that need the name.
   *
   * BOTH READS ARE ASSERTED because the list and the single record are SEPARATE service methods. A
   * change that drops the resolution from one of them leaves that screen showing a uuid again, and
   * asserting only the list is what would let it happen unnoticed.
   */
  it('names the owner in the register and in the single risk', async () => {
    const risk = await identify(3, 3);

    const listed = unwrap<RiskRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/risks?search=${encodeURIComponent(risk.reference)}&limit=100`,
        )
      ).body,
    );
    const row = listed.find((r) => r.id === risk.id);
    expect(row, 'the risk under test is not in the register listing').toBeDefined();
    expect(
      row!.ownerName,
      `risk ${row!.reference} came back with owner ${row!.ownerId} and no name`,
    ).toBeTruthy();

    const one = await apiRequest(app, security, 'GET', `/risks/${risk.id}`);
    expect(one.status).toBe(200);
    // The same name from the other method, not merely "some name": the two paths resolve the same id
    // and a mismatch would mean one of them is resolving something else.
    expect(unwrap<RiskRow>(one.body).ownerName).toBe(row!.ownerName);
  });

  /*
   * The WRITE paths deliberately do NOT resolve it, and that is worth pinning rather than leaving to a
   * reader's assumption. Every mutation response here is discarded by the SPA, which refetches the
   * list — so resolving a name on `POST /risks` would be a directory query nobody ever reads, on
   * eight endpoints. `null` is therefore the correct answer, and specifically not the uuid: falling
   * back to the id is a one-character mistake that would put back everything this removed.
   */
  it('leaves the name off a write response rather than echoing the uuid', async () => {
    const created = await identify(2, 2);
    expect(created.ownerName).toBeNull();
    expect(created.ownerId).toBe(FIXTURE.SECURITY.id);
  });
});

describe('authorization', () => {
  it('lets a risk.read holder read but not manage', async () => {
    const risk = await identify(3, 3);

    expect((await apiRequest(app, auditor, 'GET', '/risks')).status).toBe(200);
    expect((await apiRequest(app, auditor, 'GET', `/risks/${risk.id}`)).status).toBe(200);
    expect((await apiRequest(app, auditor, 'GET', `/risks/${risk.id}/treatments`)).status).toBe(
      200,
    );

    expect(
      (
        await apiRequest(app, auditor, 'POST', '/risks', {
          reference: nextRef(),
          title: 'Not allowed',
          description: 'An auditor may not write to the register.',
          category: 'vulnerability',
          ownerId: FIXTURE.SECURITY.id,
          inherent: { likelihood: 2, impact: 2 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await apiRequest(app, auditor, 'POST', `/risks/${risk.id}/assess`, {
          decision: 'mitigate',
          residual: { likelihood: 1, impact: 1 },
        })
      ).status,
    ).toBe(403);
  });

  it('refuses the register entirely to a caller holding nothing', async () => {
    expect((await apiRequest(app, employee, 'GET', '/risks')).status).toBe(403);
    const risk = await identify(2, 2);
    expect((await apiRequest(app, employee, 'GET', `/risks/${risk.id}`)).status).toBe(403);
  });
});

describe('unknown ids', () => {
  it('404s rather than answering emptily', async () => {
    const missing = '00000000-0000-7000-8000-0000000000ff';
    expect((await apiRequest(app, security, 'GET', `/risks/${missing}`)).status).toBe(404);
    expect((await apiRequest(app, security, 'GET', `/risks/${missing}/treatments`)).status).toBe(
      404,
    );
    expect(
      (await apiRequest(app, security, 'PATCH', `/risks/treatments/${missing}`, { status: 'done' }))
        .status,
    ).toBe(404);
  });
});

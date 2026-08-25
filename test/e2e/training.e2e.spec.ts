/**
 * Training records end to end: the catalogue, position requirements, the retraining chain, the
 * competency gap report, and a REAL certificate upload.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - ONE CURRENT RECORD per (employee, course) — `uq_training_record_current`, a partial unique
 *     index. Only a real Postgres can prove it, which is why this file exists at all.
 *   - `expires_on` is DERIVED from the course and then frozen; editing the course afterwards does
 *     not restate it
 *   - the GAP REPORT reads the employee's CURRENT position, so it answers "is the org competent?"
 *     and survives a transfer with no backfill
 *   - the certificate path is exercised against real S3: presigned PUT with exactly the signed
 *     headers, `Content-Disposition` stored as object METADATA, confirm verifying size, the
 *     per-record quota, and an id that is only a capability if the link row exists
 *   - `training.read` is not `training.manage`, and an employee may attach evidence to their OWN
 *     record with no permission at all
 *
 * REAL BYTES, NOT A STUB. A stubbed StorageService would agree with whatever the code did, so it
 * could not catch the two things that actually broke here during development: that a header named in
 * the presign command but absent from `signableHeaders` is silently dropped, and that a presigned
 * GET returned a Promise cast to a string. Both were invisible until something PUT and fetched.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 * CI runs a LocalStack service and creates the bucket before this suite — see backend-ci.yml.
 */
import { createHash } from 'node:crypto';
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
/** Holds `training.read` AND `training.manage`. */
let hr: Session;
/** Holds `training.read` only — the tier that separates reading from managing. */
let auditor: Session;
/** Holds no permission codes at all — used only to prove the routes are closed to them. */
let employee: Session;
/**
 * The SUBJECT of every record below, and deliberately NOT the shared `NO_PERMISSIONS` employee.
 *
 * The gap report needs its subject to hold a current position, so this suite assigns them to one —
 * and `positions-headcount.e2e.spec.ts` and `contracts.e2e.spec.ts` both drive `NO_PERMISSIONS`
 * through position transfers of their own. Sharing the fixture makes the three files
 * order-dependent in BOTH directions: whichever runs first leaves an open assignment, and the next
 * one's transfer is dated behind it and refused with `POSITION_INVALID_WINDOW`. That is exactly
 * what happened in CI, where the file order differs from the local one.
 *
 * `SECURITY` holds no training permission either, so the self-service assertions below still prove
 * what they claim: attaching evidence to your own record needs no permission code.
 */
let subject: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextCode = (): string => `E2E-${RUN}-${++seq}`;

interface CourseRow {
  id: string;
  code: string;
  validityMonths: number | null;
  retiredAt: string | null;
}
interface RecordRow {
  id: string;
  employeeId: string;
  /**
   * Resolved server-side on the READ paths only. Null on the write responses, which is asserted
   * below — a record hands the row back to a caller who just supplied the employee id.
   */
  employeeName: string | null;
  courseId: string;
  completedOn: string;
  expiresOn: string | null;
  status: string;
  verifiedBy: string | null;
  supersededById: string | null;
}
interface GapRow {
  courseCode: string;
  kind: string;
  reason: string;
  employeeId: string;
  /** Resolved server-side. Null only when the directory row behind the assignment has gone. */
  employeeName: string | null;
}
interface PresignRow {
  fileId: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
}
interface CertificateRow {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string | null;
}

async function createCourse(over: Record<string, unknown> = {}): Promise<CourseRow> {
  const res = await apiRequest(app, hr, 'POST', '/training/courses', {
    code: nextCode(),
    title: 'Security Awareness',
    category: 'information_security',
    validityMonths: 12,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<CourseRow>(res.body);
}

/** A position nobody else is using, with the employee assigned to it from `effectiveFrom`. */
async function positionWithEmployee(effectiveFrom: string): Promise<string> {
  const created = await apiRequest(app, hr, 'POST', '/positions', {
    code: nextCode(),
    title: 'Training Subject',
    department: `E2E-TRAIN-${RUN}`,
    headcount: 5,
  });
  expect(created.status).toBe(201);
  const positionId = unwrap<{ id: string }>(created.body).id;

  const assigned = await apiRequest(app, hr, 'POST', `/positions/${positionId}/assignments`, {
    employeeId: FIXTURE.SECURITY.id,
    effectiveFrom,
  });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
  return positionId;
}

/** Whether this environment has S3 — the upload assertions need it and cannot fake it. */
const HAS_S3 = Boolean(process.env['S3_FILES_BUCKET']);

beforeAll(async () => {
  app = await createTestApp();
  hr = await login(app, FIXTURE.HR);
  auditor = await login(app, FIXTURE.AUDITOR);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  subject = await login(app, FIXTURE.SECURITY);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('the course catalogue', () => {
  it('refuses a duplicate code', async () => {
    const code = nextCode();
    const first = await apiRequest(app, hr, 'POST', '/training/courses', {
      code,
      title: 'First Aid Basics',
      category: 'safety',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const dup = await apiRequest(app, hr, 'POST', '/training/courses', {
      code,
      title: 'Duplicate Code',
      category: 'safety',
    });
    expect(dup.status).toBe(409);
  });

  it('hides retired courses unless asked, and keeps them addressable', async () => {
    const course = await createCourse();
    expect(
      (await apiRequest(app, hr, 'POST', `/training/courses/${course.id}/retire`)).status,
    ).toBe(200);

    const visible = unwrap<CourseRow[]>(
      (await apiRequest(app, hr, 'GET', '/training/courses?limit=100')).body,
    );
    expect(visible.some((c) => c.id === course.id)).toBe(false);

    const all = unwrap<CourseRow[]>(
      (await apiRequest(app, hr, 'GET', '/training/courses?limit=100&includeRetired=true')).body,
    );
    expect(all.some((c) => c.id === course.id)).toBe(true);
    // Past records reference it, so it must still resolve directly.
    expect((await apiRequest(app, hr, 'GET', `/training/courses/${course.id}`)).status).toBe(200);

    // And retiring twice is refused rather than silently rewriting the date.
    expect(
      (await apiRequest(app, hr, 'POST', `/training/courses/${course.id}/retire`)).status,
    ).toBe(412);
  });

  it('refuses to require or complete a retired course', async () => {
    const course = await createCourse();
    const positionId = await positionWithEmployee('2050-01-01');
    expect(
      (await apiRequest(app, hr, 'POST', `/training/courses/${course.id}/retire`)).status,
    ).toBe(200);

    const required = await apiRequest(
      app,
      hr,
      'POST',
      `/training/positions/${positionId}/requirements`,
      {
        courseId: course.id,
      },
    );
    expect(required.status).toBe(412);

    const completed = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2026-01-01',
    });
    expect(completed.status).toBe(412);
  });
});

describe('a lapsed certificate', () => {
  /*
   * "WHO HAS LAPSED?" USED TO ANSWER "NOBODY", ALWAYS.
   *
   * `training_records.status` defaults to `valid` and the only other value ever written is `revoked`
   * — nothing in the product, and no job, ever writes `expired`. The list endpoint filtered on the
   * stored column, so the Records tab's "Expired" chip matched no row and reported "no training
   * records match these filters", while the competency-gap report on the next tab correctly counted
   * the same people as gaps. Two tabs, contradictory answers, and the reassuring one was on the
   * screen somebody reads to chase a renewal.
   *
   * `expired` is DERIVED: otherwise-valid, with an expiry date in the past. Both halves are asserted
   * here, because they are separate pieces of code — the row has to SAY it, and the filter has to
   * FIND it, and either alone leaves the register contradicting itself.
   */
  it('reads as expired, and is found by the expired filter', async () => {
    // Completed in 2020 with a 12-month validity: lapsed long ago, whenever this runs.
    const course = await createCourse({ validityMonths: 12 });
    const created = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2020-01-15',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const recordId = unwrap<RecordRow>(created.body).id;

    const listed = await apiRequest(app, hr, 'GET', `/training/records?courseId=${course.id}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = unwrap<RecordRow[]>(listed.body).find((r) => r.id === recordId);
    expect(row, 'the record under test is missing from the list').toBeDefined();
    expect(
      row!.status,
      `a certificate that expired on ${row!.expiresOn} still reads as ${row!.status}`,
    ).toBe('expired');

    const filtered = await apiRequest(
      app,
      hr,
      'GET',
      `/training/records?courseId=${course.id}&status=expired`,
    );
    expect(filtered.status).toBe(200);
    expect(
      unwrap<RecordRow[]>(filtered.body).map((r) => r.id),
      'the Expired filter did not find a lapsed record',
    ).toContain(recordId);
  });

  it('is not counted as valid, so the two filters do not overlap', async () => {
    /*
     * The other half, and the reason `valid` had to change too: if `valid` still meant "the stored
     * value", a lapsed record would appear under BOTH chips and the counts would not add up.
     */
    const course = await createCourse({ validityMonths: 12 });
    const lapsed = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2020-02-20',
    });
    expect(lapsed.status, JSON.stringify(lapsed.body)).toBe(201);
    const lapsedId = unwrap<RecordRow>(lapsed.body).id;

    const valid = await apiRequest(
      app,
      hr,
      'GET',
      `/training/records?courseId=${course.id}&status=valid`,
    );
    expect(valid.status).toBe(200);
    expect(
      unwrap<RecordRow[]>(valid.body).map((r) => r.id),
      'a lapsed certificate is being counted as a current one',
    ).not.toContain(lapsedId);
  });

  it('leaves a certificate with no expiry alone', async () => {
    /*
     * `validityMonths: null` means the qualification does not lapse — a degree, an induction. Deriving
     * a status from a null expiry would invent an expiry that the course deliberately does not have.
     */
    const course = await createCourse({ validityMonths: null });
    const created = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2020-03-10',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const recordId = unwrap<RecordRow>(created.body).id;

    const row = unwrap<RecordRow[]>(
      (await apiRequest(app, hr, 'GET', `/training/records?courseId=${course.id}`)).body,
    ).find((r) => r.id === recordId);
    expect(row!.expiresOn).toBeNull();
    expect(row!.status, 'a qualification that never lapses was marked expired').toBe('valid');
  });

  it('keeps saying revoked, which outranks expired', async () => {
    /*
     * A revoked certificate is not "expired" — it was taken away, and that distinction is the whole
     * reason both values exist. Derived status must not overwrite it, which a naive
     * "expiry in the past ⇒ expired" would do for every old revoked record.
     */
    const course = await createCourse({ validityMonths: 12 });
    const created = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2020-04-01',
    });
    const recordId = unwrap<RecordRow>(created.body).id;

    const revoked = await apiRequest(app, hr, 'POST', `/training/records/${recordId}/revoke`, {
      reason: 'e2e: revoked outranks expired',
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const row = unwrap<RecordRow[]>(
      (await apiRequest(app, hr, 'GET', `/training/records?courseId=${course.id}`)).body,
    ).find((r) => r.id === recordId);
    expect(row!.status).toBe('revoked');
  });
});

describe('recording a completion', () => {
  it('derives the expiry from the course and freezes it against a later edit', async () => {
    const course = await createCourse({ validityMonths: 12 });
    const created = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2026-01-31',
      score: '91.50',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // Clamped: there is no 31st of February.
    expect(unwrap<RecordRow>(created.body).expiresOn).toBe('2027-01-31');

    const edited = await apiRequest(app, hr, 'PATCH', `/training/courses/${course.id}`, {
      validityMonths: 1,
    });
    expect(edited.status).toBe(200);

    // The record keeps the expiry it was earned with — changing the rule governs the NEXT
    // completion, and restating history would make somebody retroactively non-compliant.
    const after = unwrap<RecordRow>(
      (await apiRequest(app, hr, 'GET', `/training/records/${unwrap<RecordRow>(created.body).id}`))
        .body,
    );
    expect(after.expiresOn).toBe('2027-01-31');
  });

  it('leaves the expiry null for a course that never lapses', async () => {
    const course = await createCourse({ validityMonths: null });
    const created = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2026-01-05',
    });
    expect(created.status).toBe(201);
    expect(unwrap<RecordRow>(created.body).expiresOn).toBeNull();
  });

  it('refuses a future date and an unknown employee', async () => {
    const course = await createCourse();

    const future = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2999-01-01',
    });
    expect(future.status).toBe(412);
    expect(errorCode(future.body)).toBe('TRAINING_INVALID_COMPLETION');

    const nobody = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: '00000000-0000-7000-8000-0000000000fe',
      courseId: course.id,
      completedOn: '2026-01-01',
    });
    expect(nobody.status).toBe(404);
  });
});

describe('retraining', () => {
  it('supersedes the previous record and leaves exactly one current', async () => {
    const course = await createCourse({ validityMonths: 12 });
    const first = unwrap<RecordRow>(
      (
        await apiRequest(app, hr, 'POST', '/training/records', {
          employeeId: FIXTURE.SECURITY.id,
          courseId: course.id,
          completedOn: '2026-01-15',
        })
      ).body,
    );
    const second = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2026-07-15',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const successor = unwrap<RecordRow>(second.body);

    const predecessor = unwrap<RecordRow>(
      (await apiRequest(app, hr, 'GET', `/training/records/${first.id}`)).body,
    );
    expect(predecessor.supersededById).toBe(successor.id);

    // `uq_training_record_current` exists to make this true.
    const current = unwrap<RecordRow[]>(
      (
        await apiRequest(
          app,
          hr,
          'GET',
          `/training/records?employeeId=${FIXTURE.SECURITY.id}&courseId=${course.id}&currentOnly=true`,
        )
      ).body,
    );
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(successor.id);
  });

  it('refuses a completion dated behind the live record', async () => {
    const course = await createCourse();
    expect(
      (
        await apiRequest(app, hr, 'POST', '/training/records', {
          employeeId: FIXTURE.SECURITY.id,
          courseId: course.id,
          completedOn: '2026-06-01',
        })
      ).status,
    ).toBe(201);

    const backdated = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2026-01-01',
    });
    // Otherwise the OLDER completion becomes current and the answer to "is this person trained?"
    // goes backwards.
    expect(backdated.status).toBe(412);
    expect(errorCode(backdated.body)).toBe('TRAINING_INVALID_COMPLETION');
  });
});

describe('verify and revoke', () => {
  it('attests once, then refuses to overwrite who attested', async () => {
    const course = await createCourse();
    const record = unwrap<RecordRow>(
      (
        await apiRequest(app, hr, 'POST', '/training/records', {
          employeeId: FIXTURE.SECURITY.id,
          courseId: course.id,
          completedOn: '2026-02-02',
        })
      ).body,
    );

    const verified = await apiRequest(app, hr, 'POST', `/training/records/${record.id}/verify`);
    expect(verified.status).toBe(200);
    expect(unwrap<RecordRow>(verified.body).verifiedBy).toBe(FIXTURE.HR.id);

    const again = await apiRequest(app, hr, 'POST', `/training/records/${record.id}/verify`);
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('TRAINING_RECORD_NOT_VERIFIABLE');
  });

  it('requires a reason to revoke, and refuses a second revocation', async () => {
    const course = await createCourse();
    const record = unwrap<RecordRow>(
      (
        await apiRequest(app, hr, 'POST', '/training/records', {
          employeeId: FIXTURE.SECURITY.id,
          courseId: course.id,
          completedOn: '2026-02-03',
        })
      ).body,
    );

    expect(
      (await apiRequest(app, hr, 'POST', `/training/records/${record.id}/revoke`, {})).status,
    ).toBe(422);

    const revoked = await apiRequest(app, hr, 'POST', `/training/records/${record.id}/revoke`, {
      reason: 'certificate could not be verified with the provider',
    });
    expect(revoked.status).toBe(200);
    expect(unwrap<RecordRow>(revoked.body).status).toBe('revoked');

    const twice = await apiRequest(app, hr, 'POST', `/training/records/${record.id}/revoke`, {
      reason: 'again',
    });
    expect(twice.status).toBe(412);
  });

  it('lets a revoked course be completed again — the slot is free', async () => {
    // The partial index excludes revoked rows on purpose: revoking evidence must not lock the
    // employee out of ever recording that course again.
    const course = await createCourse();
    const first = unwrap<RecordRow>(
      (
        await apiRequest(app, hr, 'POST', '/training/records', {
          employeeId: FIXTURE.SECURITY.id,
          courseId: course.id,
          completedOn: '2026-02-04',
        })
      ).body,
    );
    expect(
      (
        await apiRequest(app, hr, 'POST', `/training/records/${first.id}/revoke`, {
          reason: 'wrong person',
        })
      ).status,
    ).toBe(200);

    const replacement = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2026-02-05',
    });
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
  });
});

describe('the competency gap report', () => {
  it('reports never_completed, clears on completion, and reports expired by asOf', async () => {
    const mandatory = await createCourse({ validityMonths: 12 });
    const recommended = await createCourse({ validityMonths: null });
    const positionId = await positionWithEmployee('2051-01-01');

    expect(
      (
        await apiRequest(app, hr, 'POST', `/training/positions/${positionId}/requirements`, {
          courseId: mandatory.id,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await apiRequest(app, hr, 'POST', `/training/positions/${positionId}/requirements`, {
          courseId: recommended.id,
          kind: 'recommended',
        })
      ).status,
    ).toBe(201);

    const mine = () =>
      apiRequest(app, hr, 'GET', `/training/gaps?employeeId=${FIXTURE.SECURITY.id}`).then((r) =>
        unwrap<GapRow[]>(r.body),
      );

    const before = await mine();
    expect(before.map((g) => g.courseCode)).toContain(mandatory.code);
    // Mandatory only by default — a recommendation is not a finding.
    expect(before.map((g) => g.courseCode)).not.toContain(recommended.code);
    expect(before.find((g) => g.courseCode === mandatory.code)?.reason).toBe('never_completed');

    const withRecommended = unwrap<GapRow[]>(
      (
        await apiRequest(
          app,
          hr,
          'GET',
          `/training/gaps?employeeId=${FIXTURE.SECURITY.id}&includeRecommended=true`,
        )
      ).body,
    );
    expect(withRecommended.map((g) => g.courseCode)).toContain(recommended.code);

    expect(
      (
        await apiRequest(app, hr, 'POST', '/training/records', {
          employeeId: FIXTURE.SECURITY.id,
          courseId: mandatory.id,
          completedOn: '2026-03-01',
        })
      ).status,
    ).toBe(201);

    expect((await mine()).map((g) => g.courseCode)).not.toContain(mandatory.code);

    // Same record, later date: the certificate has lapsed, and the reason distinguishes that from
    // never having taken it because one needs scheduling and the other rescheduling.
    const later = unwrap<GapRow[]>(
      (
        await apiRequest(
          app,
          hr,
          'GET',
          `/training/gaps?employeeId=${FIXTURE.SECURITY.id}&asOf=2027-06-01`,
        )
      ).body,
    );
    expect(later.find((g) => g.courseCode === mandatory.code)?.reason).toBe('expired');
  });

  it('follows the employee when they transfer', async () => {
    // The whole reason requirements hang off the position rather than the person.
    const course = await createCourse({ validityMonths: null });
    const oldPosition = await positionWithEmployee('2052-01-01');
    expect(
      (
        await apiRequest(app, hr, 'POST', `/training/positions/${oldPosition}/requirements`, {
          courseId: course.id,
        })
      ).status,
    ).toBe(201);

    const before = unwrap<GapRow[]>(
      (await apiRequest(app, hr, 'GET', `/training/gaps?employeeId=${FIXTURE.SECURITY.id}`)).body,
    );
    expect(before.map((g) => g.courseCode)).toContain(course.code);

    // Transfer to a position with no requirements at all.
    await positionWithEmployee('2053-01-01');

    const after = unwrap<GapRow[]>(
      (await apiRequest(app, hr, 'GET', `/training/gaps?employeeId=${FIXTURE.SECURITY.id}`)).body,
    );
    // No backfill ran; the report simply reads the CURRENT assignment.
    expect(after.map((g) => g.courseCode)).not.toContain(course.code);
  });

  it('lets an employee see their own gaps with no training permission', async () => {
    const res = await apiRequest(app, subject, 'GET', '/training/me/gaps');
    expect(res.status).toBe(200);
  });
});

describe('naming the person a record and a gap are about', () => {
  /*
   * Both of these screens are read to answer "who", and both answered it with a uuid.
   *
   * The record list is the org-wide view — filtered by COURSE as often as by employee — so its
   * Employee column is the only thing on a row that says which person completed the training. The
   * gap report is worse still: filtered by position it is a list of different people against the
   * same course, so the employee column IS the output.
   *
   * Asserted through the API rather than the SPA because the name has to be resolved server-side:
   * `GET /v1/employees` needs `employee.read`, and `training.read` does not imply it — the AUDITOR
   * tier below holds one without the other, so a client-side lookup would have given exactly the
   * caller who reads compliance reports a 403 and a column of dashes.
   */
  it('names the employee on every row of the record list', async () => {
    /*
     * TWO PEOPLE on ONE course, and the list filtered by that course. A resolver keyed on the wrong
     * column — the verifier, say, or the course — would hand both rows the same name, and a
     * single-subject list could not tell the difference.
     */
    const course = await createCourse({ validityMonths: null });
    for (const employeeId of [FIXTURE.SECURITY.id, FIXTURE.NO_PERMISSIONS.id]) {
      const created = await apiRequest(app, hr, 'POST', '/training/records', {
        employeeId,
        courseId: course.id,
        completedOn: '2026-02-01',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      // The WRITE deliberately does not resolve: this caller just supplied the employee id, so a
      // name here would be a directory query spent restating the request. Pinned so it is not
      // "made consistent" later.
      expect(unwrap<RecordRow>(created.body).employeeName).toBeNull();
    }

    const rows = unwrap<RecordRow[]>(
      (await apiRequest(app, hr, 'GET', `/training/records?courseId=${course.id}&limit=100`)).body,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(
        row.employeeName,
        `record ${row.id} came back with employee ${row.employeeId} and no name`,
      ).toBeTruthy();
    }
    expect(new Set(rows.map((r) => r.employeeName)).size).toBe(2);
  });

  it('names them on the single record too', async () => {
    /*
     * A separate service method from the list, and deliberately separate from the `getRecord` that
     * guards verify, revoke and all five certificate routes — so this read needs its own assertion.
     * One of the two paths quietly showing a uuid is the state this change was made to end.
     */
    const course = await createCourse({ validityMonths: null });
    const created = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2026-02-02',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const recordId = unwrap<RecordRow>(created.body).id;

    const one = await apiRequest(app, hr, 'GET', `/training/records/${recordId}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const got = unwrap<RecordRow>(one.body);
    expect(got.employeeName).toBeTruthy();
    // Not the id dressed up as a name: `nameOf` falls back to null on purpose, because `?? id` is a
    // one-character mistake that puts the uuid straight back.
    expect(got.employeeName).not.toBe(got.employeeId);
  });

  it('names the person who is missing the training, in the gap report', async () => {
    /*
     * `2054-01-01` because the assignments in this file are strictly increasing: `positionWithEmployee`
     * transfers the same subject, and a date behind the open assignment is refused with
     * `POSITION_INVALID_WINDOW`.
     */
    const course = await createCourse({ validityMonths: null });
    const positionId = await positionWithEmployee('2054-01-01');
    expect(
      (
        await apiRequest(app, hr, 'POST', `/training/positions/${positionId}/requirements`, {
          courseId: course.id,
        })
      ).status,
    ).toBe(201);

    const gaps = unwrap<GapRow[]>(
      (await apiRequest(app, hr, 'GET', `/training/gaps?positionId=${positionId}`)).body,
    );
    const gap = gaps.find((g) => g.courseCode === course.code);
    expect(gap, 'the requirement did not produce a gap to name anybody in').toBeDefined();
    expect(gap!.employeeName, `gap on ${gap!.employeeId} came back with no name`).toBeTruthy();
    expect(gap!.employeeName).not.toBe(gap!.employeeId);
  });
});

describe('authorization', () => {
  it('lets a training.read holder read but not manage', async () => {
    const course = await createCourse();

    expect((await apiRequest(app, auditor, 'GET', '/training/courses')).status).toBe(200);
    expect((await apiRequest(app, auditor, 'GET', `/training/courses/${course.id}`)).status).toBe(
      200,
    );
    expect((await apiRequest(app, auditor, 'GET', '/training/gaps')).status).toBe(200);

    expect(
      (
        await apiRequest(app, auditor, 'POST', '/training/courses', {
          code: nextCode(),
          title: 'X',
          category: 'safety',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await apiRequest(app, auditor, 'POST', '/training/records', {
          employeeId: FIXTURE.SECURITY.id,
          courseId: course.id,
          completedOn: '2026-01-01',
        })
      ).status,
    ).toBe(403);
  });

  it('refuses the collection to a caller holding nothing, but not their own records', async () => {
    expect((await apiRequest(app, employee, 'GET', '/training/records')).status).toBe(403);
    expect((await apiRequest(app, employee, 'GET', '/training/courses')).status).toBe(403);

    const mine = await apiRequest(app, subject, 'GET', '/training/me');
    expect(mine.status).toBe(200);
    // Their own rows and nobody else's — `/training/me` is keyed on the caller.
    expect(unwrap<RecordRow[]>(mine.body).length).toBeGreaterThan(0);
    expect(unwrap<RecordRow[]>(mine.body).every((r) => r.employeeId === FIXTURE.SECURITY.id)).toBe(
      true,
    );
  });
});

describe.runIf(HAS_S3)('certificates, against real S3', () => {
  const bytes = Buffer.from('%PDF-1.4 e2e certificate payload');
  const digest = createHash('sha256').update(bytes).digest('base64');

  /** A record owned by the SUBJECT, so the self-service path is the one under test. */
  async function ownRecord(): Promise<string> {
    const course = await createCourse({ validityMonths: null });
    const created = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.SECURITY.id,
      courseId: course.id,
      completedOn: '2026-04-01',
    });
    expect(created.status).toBe(201);
    return unwrap<RecordRow>(created.body).id;
  }

  /**
   * PUT the bytes with exactly the signed headers.
   *
   * Returns the status AND the body: a signature or emulator mismatch comes back as a bare 400/403
   * with the explanation only in the body, and asserting on the status alone turns that into
   * "expected 400 to be 200" with nothing to act on. That cost one CI round trip.
   */
  async function put(presign: PresignRow, body: Buffer): Promise<{ status: number; body: string }> {
    const res = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: presign.requiredHeaders,
      body: new Uint8Array(body),
    });
    return { status: res.status, body: await res.text() };
  }

  it('round-trips: presign as the owner, PUT, confirm, list, download, delete', async () => {
    const recordId = await ownRecord();

    // No permission code — an employee attaching evidence to their OWN record is self-service.
    const presigned = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${recordId}/certificates/presign`,
      {
        fileName: 'certificate.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        checksumSha256: digest,
      },
    );
    expect(presigned.status, JSON.stringify(presigned.body)).toBe(201);
    const presign = unwrap<PresignRow>(presigned.body);

    // The headers the signature covers, returned rather than guessed: sending fewer or more fails
    // the signature, and that failure carries no CORS headers.
    expect(presign.requiredHeaders['Content-Type']).toBe('application/pdf');
    expect(presign.requiredHeaders['Content-Disposition']).toContain('attachment');
    const uploaded = await put(presign, bytes);
    expect(uploaded.status, uploaded.body).toBe(200);

    const confirmed = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${recordId}/certificates/${presign.fileId}/confirm`,
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    const listed = unwrap<CertificateRow[]>(
      (await apiRequest(app, hr, 'GET', `/training/records/${recordId}/certificates`)).body,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ fileName: 'certificate.pdf', sizeBytes: bytes.length });
    // The digest the client declared survived the round trip.
    expect(listed[0].checksumSha256).toBe(digest);

    const download = await apiRequest(
      app,
      hr,
      'GET',
      `/training/records/${recordId}/certificates/${presign.fileId}/download`,
    );
    expect(download.status).toBe(200);
    const url = unwrap<{ url: string }>(download.body).url;
    // A real URL, not a stringified Promise — which is what this used to be.
    expect(url).toMatch(/^https?:\/\//);
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    // Stored metadata, so it applies however the object is fetched — including through a CDN, where
    // a presigned-GET response override would not.
    expect(fetched.headers.get('content-disposition')).toContain('attachment');

    const removed = await apiRequest(
      app,
      subject,
      'DELETE',
      `/training/records/${recordId}/certificates/${presign.fileId}`,
    );
    expect(removed.status).toBe(204);
    expect(
      unwrap<CertificateRow[]>(
        (await apiRequest(app, hr, 'GET', `/training/records/${recordId}/certificates`)).body,
      ),
    ).toHaveLength(0);
  });

  it('refuses a size that does not match what was declared', async () => {
    const recordId = await ownRecord();
    const presigned = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${recordId}/certificates/presign`,
      {
        fileName: 'short.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        checksumSha256: digest,
      },
    );
    const presign = unwrap<PresignRow>(presigned.body);

    // The signature pins content-length, so a different body is rejected at the edge; if a backend
    // ever accepts it, confirm's HeadObject comparison is the second line.
    const putResult = await put(presign, Buffer.from('too short'));
    if (putResult.status === 200) {
      const confirmed = await apiRequest(
        app,
        subject,
        'POST',
        `/training/records/${recordId}/certificates/${presign.fileId}/confirm`,
      );
      expect(confirmed.status).toBe(422);
      expect(errorCode(confirmed.body)).toBe('FILE_SIZE_MISMATCH');
    } else {
      expect(putResult.status, putResult.body).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses to confirm a file that was never uploaded', async () => {
    const recordId = await ownRecord();
    const presigned = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${recordId}/certificates/presign`,
      {
        fileName: 'ghost.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
      },
    );
    const presign = unwrap<PresignRow>(presigned.body);

    const confirmed = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${recordId}/certificates/${presign.fileId}/confirm`,
    );
    expect(confirmed.status).toBe(422);
    expect(errorCode(confirmed.body)).toBe('FILE_NOT_UPLOADED');
  });

  it('enforces the per-record quota at confirm time', async () => {
    const recordId = await ownRecord();
    const limit = 5; // `RESOURCE_RULES['training-certificate'].maxPerOwner`

    for (let i = 0; i < limit; i++) {
      const body = Buffer.concat([bytes, Buffer.from([i])]);
      const presigned = await apiRequest(
        app,
        subject,
        'POST',
        `/training/records/${recordId}/certificates/presign`,
        {
          fileName: `cert-${i}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: body.length,
          checksumSha256: createHash('sha256').update(body).digest('base64'),
        },
      );
      expect(presigned.status, `presign ${i}: ${JSON.stringify(presigned.body)}`).toBe(201);
      const presign = unwrap<PresignRow>(presigned.body);
      const put_ = await put(presign, body);
      expect(put_.status, put_.body).toBe(200);
      const confirmed = await apiRequest(
        app,
        subject,
        'POST',
        `/training/records/${recordId}/certificates/${presign.fileId}/confirm`,
      );
      expect(confirmed.status, `confirm ${i}: ${JSON.stringify(confirmed.body)}`).toBe(200);
    }

    const overTheLine = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${recordId}/certificates/presign`,
      { fileName: 'sixth.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length },
    );
    expect(overTheLine.status).toBe(412);
    expect(errorCode(overTheLine.body)).toBe('ATTACHMENT_LIMIT_EXCEEDED');
  });

  it('refuses SVG, and anything outside the policy', async () => {
    const recordId = await ownRecord();
    // SVG is active content: an "image" upload that renders inline is stored XSS the moment the
    // bytes come from an origin the app trusts.
    const svg = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${recordId}/certificates/presign`,
      {
        fileName: 'logo.svg',
        mimeType: 'image/svg+xml',
        sizeBytes: 100,
      },
    );
    expect(svg.status).toBe(422);

    const huge = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${recordId}/certificates/presign`,
      {
        fileName: 'big.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 21 * 1024 * 1024,
      },
    );
    expect(huge.status).toBe(422);
  });

  it("refuses to touch another employee's record without training.manage", async () => {
    const course = await createCourse({ validityMonths: null });
    const hrOwn = await apiRequest(app, hr, 'POST', '/training/records', {
      employeeId: FIXTURE.MANAGER.id,
      courseId: course.id,
      completedOn: '2026-04-02',
    });
    expect(hrOwn.status).toBe(201);
    const foreignId = unwrap<RecordRow>(hrOwn.body).id;

    const presigned = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${foreignId}/certificates/presign`,
      { fileName: 'not-mine.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
    );
    expect(presigned.status).toBe(403);

    // HR holds `training.manage`, so the same call is allowed — the 403 above is the rule, not a
    // broken route.
    const asHr = await apiRequest(
      app,
      hr,
      'POST',
      `/training/records/${foreignId}/certificates/presign`,
      {
        fileName: 'mine-to-manage.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        checksumSha256: digest,
      },
    );
    expect(asHr.status).toBe(201);
  });

  it('treats an unlinked file id as not found, whoever asks', async () => {
    const a = await ownRecord();
    const b = await ownRecord();

    const presigned = await apiRequest(
      app,
      subject,
      'POST',
      `/training/records/${a}/certificates/presign`,
      {
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        checksumSha256: digest,
      },
    );
    const presign = unwrap<PresignRow>(presigned.body);
    const uploaded = await put(presign, bytes);
    expect(uploaded.status, uploaded.body).toBe(200);
    expect(
      (
        await apiRequest(
          app,
          subject,
          'POST',
          `/training/records/${a}/certificates/${presign.fileId}/confirm`,
        )
      ).status,
    ).toBe(200);

    // The file id is a capability only in combination with the record that owns it.
    const crossed = await apiRequest(
      app,
      hr,
      'GET',
      `/training/records/${b}/certificates/${presign.fileId}/download`,
    );
    expect(crossed.status).toBe(404);
    expect(errorCode(crossed.body)).toBe('ATTACHMENT_NOT_FOUND');
  });
});

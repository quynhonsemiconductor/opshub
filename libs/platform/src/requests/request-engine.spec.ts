/**
 * RequestEngine unit tests.
 *
 * All DB, authz, delegation, notification and webhook dependencies are
 * vi.fn() mocks — no database required. The db.transaction() mock calls its
 * callback with the same mock object so queries inside transactions are
 * intercepted identically.
 */
import { describe, it, expect, vi } from 'vitest';
import { ActorScope } from '../auth/actor-scope.service';
import { RequestEngine } from './request-engine.service';
import type { RequestItem } from './request-engine.types';
import {
  PermissionDeniedException,
  PreconditionFailedException,
  NotFoundException,
} from '../errors/exceptions';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal RequestItem row for mock DB returns. */
function makeRequest(overrides: Partial<RequestItem> = {}): RequestItem {
  return {
    id: 'req-1',
    type: 'leave_request',
    requesterId: 'user-requester',
    assigneeId: null,
    status: 'pending',
    priority: 'normal',
    payload: { days: 3 },
    resolutionNote: null,
    submittedAt: new Date('2025-01-01T00:00:00Z'),
    resolvedAt: null,
    expiresAt: null,
    slaHours: null,
    slaDeadline: null,
    slaBreachedAt: null,
    currentStep: 1,
    totalSteps: 1,
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Standard typeDef stub — single-step, no hooks.
 *
 * `leave_request`, not `leave`: the stub used a type the registry never holds, which typing
 * `submit(type: RequestType)` turned into a compile error. A stub exercising a non-existent
 * discriminator still passed, because the registry is mocked — so nothing here depended on the
 * value being real.
 */
function makeTypeDef(overrides: Record<string, unknown> = {}) {
  return {
    type: 'leave_request',
    requiredApprovalPermission: 'workforce.approve',
    allowSelfApproval: false,
    defaultExpiryHours: null,
    slaHours: null,
    approvalSteps: undefined,
    onApprove: vi.fn().mockResolvedValue(undefined),
    onReject: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Build a mock Drizzle query-builder chain (select/insert/update/delete). */
function makeQueryChain(returnValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'insert',
    'update',
    'delete',
    'from',
    'where',
    'set',
    'values',
    'returning',
    'limit',
    'offset',
    'orderBy',
    'innerJoin',
    'for',
    'groupBy',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Terminal calls resolve to the return value
  (chain['returning'] as ReturnType<typeof vi.fn>).mockResolvedValue(returnValue);
  (chain['limit'] as ReturnType<typeof vi.fn>).mockResolvedValue(returnValue);
  /*
   * AWAITABLE AT EVERY STAGE, which is what a real drizzle builder is.
   *
   * Before this, only `limit` and `returning` resolved, so a query ending anywhere else handed back
   * the chain object itself — and the engine did `rows.map(...)` on it. That surfaced as
   * `rows.map is not a function` in seventeen unrelated cases the moment a name lookup ended on
   * `where` instead of `limit`: a double that models one call path breaks every test in the file
   * when a different, equally valid path appears.
   */
  chain['then'] = (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
    Promise.resolve(returnValue).then(onFulfilled, onRejected);
  return chain;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACTOR = { sub: 'user-approver', email: 'approver@test.com' };
/**
 * Two people who hold the step's permission globally — the set `AuthzService.globalHoldersOf` returns.
 *
 * Named rather than inlined because the assertions care WHICH ids are notified: the requester must be
 * absent from the fan-out (self-approval is refused, so telling them would invite a 403), and each
 * holder must get their own row.
 */
const APPROVER_A = 'user-approver-a';
const APPROVER_B = 'user-approver-b';
const REQUESTER = { sub: 'user-requester', email: 'requester@test.com' };

function buildEngine(opts: {
  requestRow?: RequestItem | null;
  typeDef?: ReturnType<typeof makeTypeDef>;
  actorHasPermission?: boolean;
  activeDelegation?: { fromUserId: string } | null;
}) {
  const {
    requestRow = makeRequest(),
    typeDef = makeTypeDef(),
    actorHasPermission = true,
    activeDelegation = null,
  } = opts;

  // -- DB mock --
  // db.select().from().where().limit(1)  →  [requestRow]  (getOrFail)
  // db.transaction(cb)                  →  calls cb(db)
  const selectChain = makeQueryChain(requestRow ? [requestRow] : []);
  const insertChain = makeQueryChain([{ id: 'approval-1' }]);
  const updateChain = makeQueryChain([requestRow]);

  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    // eslint-disable-next-line @typescript-eslint/require-await
    transaction: vi.fn().mockImplementation(async (cb: (tx: typeof db) => unknown) => cb(db)),
  };

  // -- Registry mock --
  const registry = { get: vi.fn().mockReturnValue(typeDef) };

  /*
   * -- AuthzService mock --
   *
   * `globalHoldersOf` returns TWO ids, not an empty list. An empty stub would let every assertion
   * about the approval fan-out pass while covering nothing — the notification loop would simply never
   * run. Two holders is the smallest set that can show a notification going to each of them with a
   * distinct idempotency key, which is the property that stops the relay collapsing them into one.
   */
  const authz = {
    check: vi.fn().mockResolvedValue(actorHasPermission),
    globalHoldersOf: vi.fn().mockResolvedValue([APPROVER_A, APPROVER_B]),
  };

  // -- WebhookEnqueueService mock --
  const webhookEnqueue = { fanout: vi.fn().mockResolvedValue(undefined) };

  // -- DelegationService mock --
  const delegation = { findActiveDelegationTo: vi.fn().mockResolvedValue(activeDelegation) };

  // -- NotificationSchedulerService mock --
  const notifScheduler = { schedule: vi.fn().mockResolvedValue(undefined) };

  // ActorScope is the real class over the mocked AuthzService: its narrow/assert logic is what
  // the read paths now depend on, so stubbing it would test nothing.
  const actorScope = new ActorScope(authz as never);

  // Construct without NestJS DI — pass all deps directly.
  const engine = new RequestEngine(
    db as never,
    registry as never,
    authz as never,
    actorScope,
    delegation as never,
    notifScheduler as never,
    webhookEnqueue,
  );

  return {
    engine,
    db,
    registry,
    authz,
    webhookEnqueue,
    delegation,
    notifScheduler,
    updateChain,
    insertChain,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// submit()
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The notification inputs the engine handed the scheduler, typed.
 *
 * `mock.calls` is `any[][]`, so reading `input.recipientId` off it directly is eighteen
 * `no-unsafe-member-access` errors and no type safety. One narrowing here gives every assertion a
 * real shape, and the shape is checked against `ScheduleNotificationInput` by the call sites.
 */
interface ScheduledNotification {
  type: string;
  recipientId: string;
  idempotencyKey: string;
}

function scheduledNotifications(notifScheduler: {
  schedule: { mock: { calls: unknown[][] } };
}): ScheduledNotification[] {
  return notifScheduler.schedule.mock.calls.map(([, input]) => input as ScheduledNotification);
}

describe('RequestEngine.submit()', () => {
  it('inserts a request row and enqueues webhook events', async () => {
    const submittedRow = makeRequest({ id: 'req-new', requesterId: REQUESTER.sub });
    const { engine, db, webhookEnqueue } = buildEngine({
      typeDef: makeTypeDef({ onSubmit: undefined }),
    });

    // First transaction call: insert returning [submittedRow]
    const insertChain = makeQueryChain([submittedRow]);
    db.insert.mockReturnValue(insertChain);

    const result = await engine.submit('leave_request', { days: 3 }, REQUESTER);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.insert).toHaveBeenCalled();
    expect(webhookEnqueue.fanout).toHaveBeenCalledWith(
      expect.anything(),
      'request.submitted',
      expect.objectContaining({ type: 'leave_request', requesterId: REQUESTER.sub }),
    );
    expect(result.requesterId).toBe(REQUESTER.sub);
  });

  /*
   * WHO GETS TOLD A REQUEST IS WAITING.
   *
   * This whole group exists because the answer used to be "nobody". The notification was guarded by
   * `if (row.assigneeId)`, and no production path sets an assignee: no `RequestTypeDef` defines a
   * `resolverFn` and no caller passes `opts.assigneeId`. Measured on a seeded database, 71 request
   * rows had one assignee between them, written by a test — so every real request was submitted
   * silently and `request.step_ready` had never been delivered once.
   */
  describe('notifying the people who can decide it', () => {
    it('tells every unconstrained holder of the step permission, one row each', async () => {
      const submittedRow = makeRequest({ id: 'req-fan', requesterId: REQUESTER.sub });
      const { engine, db, authz, notifScheduler } = buildEngine({
        typeDef: makeTypeDef({ onSubmit: undefined }),
      });
      db.insert.mockReturnValue(makeQueryChain([submittedRow]));

      await engine.submit('leave_request', { days: 3 }, REQUESTER);

      // The permission asked for is the step's, not a guess.
      expect(authz.globalHoldersOf).toHaveBeenCalledWith('workforce.approve', expect.anything());

      const recipients = scheduledNotifications(notifScheduler)
        .filter((input) => input.type === 'request.submitted')
        .map((input) => input.recipientId);
      expect(recipients).toEqual([APPROVER_A, APPROVER_B]);
    });

    it("asks for STEP ONE's permission on a multi-step type, not the type default", async () => {
      /*
       * A mutation that replaced `approvalSteps[0].requiredPermission` with the type-level
       * `requiredApprovalPermission` SURVIVED every other test here, because they all use a type with
       * no `approvalSteps` — the two expressions are the same value when there are no steps. On a
       * multi-step type they are not, and asking for the wrong one notifies the wrong people: the
       * holders of a permission that only matters at the END of the chain.
       */
      const submittedRow = makeRequest({ id: 'req-multi', requesterId: REQUESTER.sub });
      const { engine, db, authz } = buildEngine({
        typeDef: makeTypeDef({
          onSubmit: undefined,
          requiredApprovalPermission: 'onboarding.complete',
          approvalSteps: [
            { step: 1, requiredPermission: 'onboarding.approve' },
            { step: 2, requiredPermission: 'onboarding.provision' },
          ],
        }),
      });
      db.insert.mockReturnValue(makeQueryChain([submittedRow]));

      await engine.submit('onboarding', { employeeId: 'e1' }, REQUESTER);

      expect(authz.globalHoldersOf).toHaveBeenCalledWith('onboarding.approve', expect.anything());
      expect(authz.globalHoldersOf).not.toHaveBeenCalledWith(
        'onboarding.complete',
        expect.anything(),
      );
    });

    it('gives each recipient its own idempotency key', async () => {
      // The relay dedupes on this key. A shared one delivers to whoever is written first and drops
      // the rest — which would look exactly like the fan-out working.
      const submittedRow = makeRequest({ id: 'req-idem', requesterId: REQUESTER.sub });
      const { engine, db, notifScheduler } = buildEngine({
        typeDef: makeTypeDef({ onSubmit: undefined }),
      });
      db.insert.mockReturnValue(makeQueryChain([submittedRow]));

      await engine.submit('leave_request', { days: 3 }, REQUESTER);

      const keys = scheduledNotifications(notifScheduler)
        .filter((input) => input.type === 'request.submitted')
        .map((input) => input.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual([
        `request_submitted:req-idem:${APPROVER_A}`,
        `request_submitted:req-idem:${APPROVER_B}`,
      ]);
    });

    it('never asks the requester to decide their own request', async () => {
      // `approve()` refuses self-approval, so this prompt would only ever collect a 403.
      const submittedRow = makeRequest({ id: 'req-self', requesterId: REQUESTER.sub });
      const { engine, db, authz, notifScheduler } = buildEngine({
        typeDef: makeTypeDef({ onSubmit: undefined }),
      });
      authz.globalHoldersOf.mockResolvedValue([APPROVER_A, REQUESTER.sub, APPROVER_B]);
      db.insert.mockReturnValue(makeQueryChain([submittedRow]));

      await engine.submit('leave_request', { days: 3 }, REQUESTER);

      const recipients = scheduledNotifications(notifScheduler).map((input) => input.recipientId);
      expect(recipients).not.toContain(REQUESTER.sub);
      expect(recipients).toEqual([APPROVER_A, APPROVER_B]);
    });

    it('honours an explicit assignee instead of fanning out', async () => {
      // Naming an approver is a decision the caller made. Notifying everyone anyway would override it.
      const submittedRow = makeRequest({ id: 'req-assigned', requesterId: REQUESTER.sub });
      submittedRow.assigneeId = 'user-named-approver';
      const { engine, db, authz, notifScheduler } = buildEngine({
        typeDef: makeTypeDef({ onSubmit: undefined }),
      });
      db.insert.mockReturnValue(makeQueryChain([submittedRow]));

      await engine.submit('leave_request', { days: 3 }, REQUESTER, {
        assigneeId: 'user-named-approver',
      });

      const recipients = scheduledNotifications(notifScheduler).map((input) => input.recipientId);
      expect(recipients).toEqual(['user-named-approver']);
      // And the reverse lookup is not even attempted — there is nothing to resolve.
      expect(authz.globalHoldersOf).not.toHaveBeenCalled();
    });

    it('schedules nothing when no one holds the permission globally', async () => {
      // A step nobody can act on. The request is still created — losing the work because nobody could
      // be told would be worse — but it must not look like a delivered notification.
      const submittedRow = makeRequest({ id: 'req-nobody', requesterId: REQUESTER.sub });
      const { engine, db, authz, notifScheduler } = buildEngine({
        typeDef: makeTypeDef({ onSubmit: undefined }),
      });
      authz.globalHoldersOf.mockResolvedValue([]);
      db.insert.mockReturnValue(makeQueryChain([submittedRow]));

      const result = await engine.submit('leave_request', { days: 3 }, REQUESTER);

      expect(result.id).toBe('req-nobody');
      expect(notifScheduler.schedule).not.toHaveBeenCalled();
    });
  });

  it('calls onSubmit hook when defined', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const submittedRow = makeRequest();
    const { engine, db } = buildEngine({ typeDef: makeTypeDef({ onSubmit }) });

    const insertChain = makeQueryChain([submittedRow]);
    db.insert.mockReturnValue(insertChain);

    await engine.submit('leave_request', { days: 3 }, REQUESTER);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('computes expiresAt from defaultExpiryHours when not overridden', async () => {
    const typeDef = makeTypeDef({ defaultExpiryHours: 48 });
    const submittedRow = makeRequest();
    const { engine, db } = buildEngine({ typeDef });

    const insertChain = makeQueryChain([submittedRow]);
    db.insert.mockReturnValue(insertChain);

    const before = Date.now();
    await engine.submit('leave_request', {}, REQUESTER);
    const after = Date.now();

    const insertValues = (insertChain['values'] as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(insertValues['expiresAt']).toBeDefined();
    const expiresMs = (insertValues['expiresAt'] as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 48 * 3_600_000 - 100);
    expect(expiresMs).toBeLessThanOrEqual(after + 48 * 3_600_000 + 100);
  });

  it('stores totalSteps from approvalSteps length', async () => {
    const typeDef = makeTypeDef({
      approvalSteps: [
        { step: 1, requiredPermission: 'onboarding.approve' },
        { step: 2, requiredPermission: 'onboarding.provision' },
        { step: 3, requiredPermission: 'onboarding.complete' },
      ],
    });
    const submittedRow = makeRequest({ totalSteps: 3 });
    const { engine, db } = buildEngine({ typeDef });
    const insertChain = makeQueryChain([submittedRow]);
    db.insert.mockReturnValue(insertChain);

    await engine.submit('onboarding', {}, REQUESTER);

    const insertValues = (insertChain['values'] as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(insertValues['totalSteps']).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// approve() — single-step
// ═════════════════════════════════════════════════════════════════════════════

describe('RequestEngine.approve() — single-step', () => {
  it('sets status to approved and calls onApprove hook', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const approvedRow = makeRequest({ status: 'approved', resolvedAt: new Date() });

    const { engine, db, webhookEnqueue } = buildEngine({
      requestRow: makeRequest(),
      typeDef: makeTypeDef({ onApprove }),
    });

    const updateChain = makeQueryChain([approvedRow]);
    db.update.mockReturnValue(updateChain);

    const result = await engine.approve('req-1', 'LGTM', ACTOR);

    expect(onApprove).toHaveBeenCalledOnce();
    expect(webhookEnqueue.fanout).toHaveBeenCalledWith(
      expect.anything(),
      'request.approved',
      expect.objectContaining({ isFinalStep: true }),
    );
    expect(result.status).toBe('approved');
  });

  it('refuses a missing permission as FORBIDDEN', async () => {
    const { engine } = buildEngine({
      requestRow: makeRequest(),
      actorHasPermission: false,
    });

    await expect(engine.approve('req-1', null, ACTOR)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses self-approval as REQUEST_SOD_VIOLATION, not as a missing permission', async () => {
    const sameUser = 'user-requester';
    const { engine } = buildEngine({
      requestRow: makeRequest({ requesterId: sameUser }),
      actorHasPermission: true,
    });

    /*
     * THE DISTINCTION, as a test. Both refusals are 403 and both were `FORBIDDEN`, so a client could
     * not tell "ask a colleague to approve this" from "ask for access" — and the difference survived
     * only as a prefix on the message, where nothing can act on it. The code carries it now.
     */
    await expect(
      engine.approve('req-1', null, { sub: sameUser, email: 'x@x.com' }),
    ).rejects.toMatchObject({
      code: 'REQUEST_SOD_VIOLATION',
      // Still a 403. `httpStatus`, not `category`: the shared base converts the category to a status
      // and does not keep it, so this pins the number that actually reaches the client.
      httpStatus: 403,
    });
  });

  it('says nothing about SoD in the message that the code does not say', async () => {
    // The prefix is gone. A message that repeats the code is a second place to keep them in step.
    const sameUser = 'user-requester';
    const { engine } = buildEngine({
      requestRow: makeRequest({ requesterId: sameUser }),
      actorHasPermission: true,
    });

    await expect(
      engine.approve('req-1', null, { sub: sameUser, email: 'x@x.com' }),
    ).rejects.toThrow(/^Requester cannot approve their own request$/);
  });

  it('throws NotFoundException when request does not exist', async () => {
    const { engine } = buildEngine({ requestRow: null });
    await expect(engine.approve('req-missing', null, ACTOR)).rejects.toThrow(NotFoundException);
  });

  it('throws PreconditionFailedException when status is not pending/in_review', async () => {
    const { engine } = buildEngine({
      requestRow: makeRequest({ status: 'approved' }),
    });
    await expect(engine.approve('req-1', null, ACTOR)).rejects.toThrow(PreconditionFailedException);
  });

  it('allows approval when actor is a delegate of the original approver', async () => {
    const delegatee = { sub: 'delegatee', email: 'delegatee@test.com' };
    const approvedRow = makeRequest({ status: 'approved', resolvedAt: new Date() });

    // Actor (delegatee) has NO direct permission; delegator has it
    const { engine, db, authz } = buildEngine({
      requestRow: makeRequest({ requesterId: 'someone-else' }),
      actorHasPermission: false,
      activeDelegation: { fromUserId: 'original-approver' },
    });

    // delegator has permission
    authz.check
      .mockResolvedValueOnce(false) // actor check
      .mockResolvedValueOnce(true); // delegator check

    const updateChain = makeQueryChain([approvedRow]);
    db.update.mockReturnValue(updateChain);

    const result = await engine.approve('req-1', null, delegatee);
    expect(result.status).toBe('approved');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// approve() — multi-step
// ═════════════════════════════════════════════════════════════════════════════

describe('RequestEngine.approve() — multi-step (3-step onboarding)', () => {
  const steps = [
    { step: 1, requiredPermission: 'onboarding.approve' },
    { step: 2, requiredPermission: 'onboarding.provision' },
    { step: 3, requiredPermission: 'onboarding.complete' },
  ];

  it('advances to step 2 (in_review) on first approval, fires step_approved webhook', async () => {
    const onStepApproved = vi.fn().mockResolvedValue(undefined);
    const inReviewRow = makeRequest({ status: 'in_review', currentStep: 2, totalSteps: 3 });

    const { engine, db, webhookEnqueue } = buildEngine({
      requestRow: makeRequest({ currentStep: 1, totalSteps: 3 }),
      typeDef: makeTypeDef({ approvalSteps: steps, onStepApproved }),
    });

    const updateChain = makeQueryChain([inReviewRow]);
    db.update.mockReturnValue(updateChain);

    const result = await engine.approve('req-1', null, ACTOR);

    expect(result.status).toBe('in_review');
    expect(onStepApproved).toHaveBeenCalledWith(
      expect.anything(),
      'req-1',
      1,
      2,
      null,
      ACTOR.sub,
      expect.anything(),
    );
    expect(webhookEnqueue.fanout).toHaveBeenCalledWith(
      expect.anything(),
      'request.step_approved',
      expect.objectContaining({ isFinalStep: false, step: 1 }),
    );
  });

  it("tells the NEXT step's approvers when a step is cleared", async () => {
    /*
     * The branch that had never run in production. `request.step_ready` was guarded by
     * `if (nextAssigneeId)`, which comes from a `resolverFn` no `RequestTypeDef` defines — zero
     * deliveries on a database with 71 requests. A half-approved request is the one most needing
     * attention, and it was the one nobody heard about.
     *
     * The permission asserted is step TWO's. Notifying step one's holders again would tell the people
     * who just finished, and leave the people who now have to act uninformed.
     */
    const inReviewRow = makeRequest({ status: 'in_review', currentStep: 2, totalSteps: 3 });
    const { engine, db, authz, notifScheduler } = buildEngine({
      requestRow: makeRequest({ currentStep: 1, totalSteps: 3, requesterId: REQUESTER.sub }),
      typeDef: makeTypeDef({ approvalSteps: steps }),
    });
    db.update.mockReturnValue(makeQueryChain([inReviewRow]));

    await engine.approve('req-1', null, ACTOR);

    expect(authz.globalHoldersOf).toHaveBeenCalledWith('onboarding.provision', expect.anything());

    const ready = scheduledNotifications(notifScheduler).filter(
      (input) => input.type === 'request.step_ready',
    );
    expect(ready.map((input) => input.recipientId)).toEqual([APPROVER_A, APPROVER_B]);
    // Keyed per recipient AND per step, so clearing step 2 later cannot dedupe against step 1.
    expect(ready.map((input) => input.idempotencyKey)).toEqual([
      `step_ready:req-1:2:${APPROVER_A}`,
      `step_ready:req-1:2:${APPROVER_B}`,
    ]);
  });

  it('does not ask the requester to approve the next step either', async () => {
    const inReviewRow = makeRequest({ status: 'in_review', currentStep: 2, totalSteps: 3 });
    const { engine, db, authz, notifScheduler } = buildEngine({
      requestRow: makeRequest({ currentStep: 1, totalSteps: 3, requesterId: REQUESTER.sub }),
      typeDef: makeTypeDef({ approvalSteps: steps }),
    });
    authz.globalHoldersOf.mockResolvedValue([REQUESTER.sub, APPROVER_A]);
    db.update.mockReturnValue(makeQueryChain([inReviewRow]));

    await engine.approve('req-1', null, ACTOR);

    const recipients = scheduledNotifications(notifScheduler)
      .filter((input) => input.type === 'request.step_ready')
      .map((input) => input.recipientId);
    expect(recipients).not.toContain(REQUESTER.sub);
    expect(recipients).toEqual([APPROVER_A]);
  });

  it('sets approved on final step (step 3) and calls onApprove', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const approvedRow = makeRequest({ status: 'approved', currentStep: 3, totalSteps: 3 });

    const { engine, db, webhookEnqueue } = buildEngine({
      requestRow: makeRequest({ status: 'in_review', currentStep: 3, totalSteps: 3 }),
      typeDef: makeTypeDef({ approvalSteps: steps, onApprove }),
    });

    const updateChain = makeQueryChain([approvedRow]);
    db.update.mockReturnValue(updateChain);

    await engine.approve('req-1', null, ACTOR);

    expect(onApprove).toHaveBeenCalledOnce();
    expect(webhookEnqueue.fanout).toHaveBeenCalledWith(
      expect.anything(),
      'request.approved',
      expect.objectContaining({ isFinalStep: true, step: 3 }),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// reject()
// ═════════════════════════════════════════════════════════════════════════════

describe('RequestEngine.reject()', () => {
  it('sets status to rejected, calls onReject, enqueues events', async () => {
    const onReject = vi.fn().mockResolvedValue(undefined);
    const rejectedRow = makeRequest({ status: 'rejected', resolvedAt: new Date() });

    const { engine, db, webhookEnqueue } = buildEngine({
      requestRow: makeRequest(),
      typeDef: makeTypeDef({ onReject }),
    });

    const updateChain = makeQueryChain([rejectedRow]);
    db.update.mockReturnValue(updateChain);

    const result = await engine.reject('req-1', 'Not approved', ACTOR);

    expect(onReject).toHaveBeenCalledOnce();
    expect(webhookEnqueue.fanout).toHaveBeenCalledWith(
      expect.anything(),
      'request.rejected',
      expect.objectContaining({ requestId: 'req-1' }),
    );
    expect(result.status).toBe('rejected');
  });

  it('throws PermissionDeniedException when actor lacks permission', async () => {
    const { engine } = buildEngine({
      requestRow: makeRequest(),
      actorHasPermission: false,
    });
    await expect(engine.reject('req-1', null, ACTOR)).rejects.toThrow(PermissionDeniedException);
  });

  it('enforces SoD on reject with the same code as on approve', async () => {
    // Rejecting your own request is the same violation as approving it — an approver who can reject
    // can close the request, which is the decision SoD exists to separate.
    const { engine } = buildEngine({
      requestRow: makeRequest({ requesterId: ACTOR.sub }),
    });
    await expect(engine.reject('req-1', null, ACTOR)).rejects.toMatchObject({
      code: 'REQUEST_SOD_VIOLATION',
      httpStatus: 403,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// cancel()
// ═════════════════════════════════════════════════════════════════════════════

describe('RequestEngine.cancel()', () => {
  it('allows requester to cancel their own pending request', async () => {
    const cancelledRow = makeRequest({ status: 'cancelled', resolvedAt: new Date() });

    const { engine, db, webhookEnqueue } = buildEngine({
      requestRow: makeRequest({ requesterId: REQUESTER.sub }),
    });

    const updateChain = makeQueryChain([cancelledRow]);
    db.update.mockReturnValue(updateChain);

    const result = await engine.cancel('req-1', REQUESTER);

    expect(webhookEnqueue.fanout).toHaveBeenCalledWith(
      expect.anything(),
      'request.cancelled',
      expect.objectContaining({ cancelledBy: REQUESTER.sub }),
    );
    expect(result.status).toBe('cancelled');
  });

  it('allows an admin (rbac.manage) to cancel any request', async () => {
    const cancelledRow = makeRequest({ status: 'cancelled' });
    const admin = { sub: 'admin-user', email: 'admin@test.com' };

    const { engine, db, authz } = buildEngine({
      requestRow: makeRequest({ requesterId: 'someone-else' }),
      actorHasPermission: true,
    });

    authz.check.mockResolvedValue(true); // has rbac.manage

    const updateChain = makeQueryChain([cancelledRow]);
    db.update.mockReturnValue(updateChain);

    await expect(engine.cancel('req-1', admin)).resolves.not.toThrow();
  });

  it('throws PermissionDeniedException when non-requester non-admin tries to cancel', async () => {
    const { engine } = buildEngine({
      requestRow: makeRequest({ requesterId: 'someone-else' }),
      actorHasPermission: false, // does not have rbac.manage
    });
    await expect(engine.cancel('req-1', ACTOR)).rejects.toThrow(PermissionDeniedException);
  });

  it('throws PreconditionFailedException when request is already resolved', async () => {
    const { engine } = buildEngine({
      requestRow: makeRequest({ requesterId: REQUESTER.sub, status: 'approved' }),
    });
    await expect(engine.cancel('req-1', REQUESTER)).rejects.toThrow(PreconditionFailedException);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// expire()
// ═════════════════════════════════════════════════════════════════════════════

describe('RequestEngine.expire()', () => {
  it('sets status to expired and fires webhook + outbox events', async () => {
    const { engine, db, webhookEnqueue } = buildEngine({
      requestRow: makeRequest({ status: 'pending' }),
    });

    const updateChain = makeQueryChain([makeRequest({ status: 'expired' })]);
    db.update.mockReturnValue(updateChain);

    await engine.expire('req-1');

    expect(webhookEnqueue.fanout).toHaveBeenCalledWith(
      expect.anything(),
      'request.expired',
      expect.objectContaining({ requestId: 'req-1' }),
    );
  });

  it('is a no-op when request is already resolved', async () => {
    const { engine, webhookEnqueue } = buildEngine({
      requestRow: makeRequest({ status: 'approved' }),
    });

    await engine.expire('req-1');
    // Was asserted against the outbox enqueue, which is gone; the webhook fan-out is the
    // remaining observable side effect, so its absence is what "no-op" now means.
    expect(webhookEnqueue.fanout).not.toHaveBeenCalled();
  });
});

/*
 * NOT TESTED HERE: that `list()` resolves the names on a page in ONE query rather than one per row.
 *
 * Three sets of ids ride that single lookup now — requesters, assignees, and the approver on every
 * recorded decision — so the property this note is about got more valuable, not less: the obvious wrong
 * implementation is now three queries per page instead of one, or worse, one per approval row.
 *
 * It is the property that separates the implementation from the obvious wrong one, and it is invisible
 * from outside — the response is byte-identical either way. I tried twice and shipped neither:
 *
 *   - An end-to-end timing check needed more seeded rows than the fixture has, and measured the machine.
 *   - A unit test needed a `db` mock that reaches the list path. This file's `makeQueryChain` resolves on
 *     `limit`, and `list()` ends on `.offset()`, so the chain handed back a plain object and `rows.map`
 *     threw — which my first attempt swallowed in a `.catch` and passed while asserting nothing. Building
 *     a chain that answers the list path correctly means knowing the exact order of its selects, and a
 *     mock pinned to call order is a test that breaks on an unrelated refactor.
 *
 * So the guard is the batched `inArray` in `list()` and the comment above it. Recorded here because
 * "there is no test for this" is worth knowing, and a reader who assumes there is one would be wrong.
 */

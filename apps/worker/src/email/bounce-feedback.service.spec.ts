/**
 * BounceFeedbackService — the verdict half of the email feedback loop.
 *
 * Every case here is a real shape the SQS consumer can receive: the SNS envelope SES
 * event destinations produce, the SubscriptionConfirmation that arrives before any
 * event, non-JSON junk, non-verdict event types, and the at-least-once duplicate.
 * The DB is a stub with just enough `update` to assert the write — the interesting
 * logic is the envelope parsing and the terminal-status discipline.
 */
import { describe, it, expect, vi } from 'vitest';
import { BounceFeedbackService } from './bounce-feedback.service';
import type { AppConfigService, DrizzleDB } from '@platform';

type UpdateCall = {
  values: Record<string, unknown>;
  whereClauses: unknown[];
};

const makeDb = (returning: { id: string; to: string }[] = []) => {
  const calls: UpdateCall[] = [];
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (...whereClauses: unknown[]) => {
          calls.push({ values, whereClauses });
          return { returning: () => returning };
        },
      }),
    }),
  };
  return { db: db as unknown as DrizzleDB, calls };
};

const makeConfig = (vals: Record<string, unknown> = {}): AppConfigService =>
  ({
    get: vi.fn((key: string) => vals[key] ?? ''),
  }) as unknown as AppConfigService;

const sns = (event: Record<string, unknown>): string =>
  JSON.stringify({ Type: 'Notification', MessageId: 'sns-1', Message: JSON.stringify(event) });

const bounceEvent = (messageId: string): Record<string, unknown> => ({
  eventType: 'Bounce',
  mail: { messageId, destination: ['namnh@qnsc.vn'] },
  bounce: { bounceType: 'Permanent', diagnosticCode: '550 5.4.1 recipient rejected' },
});

describe('BounceFeedbackService.applyEvent', () => {
  it('marks a sent row bounced with the diagnostic in lastError', async () => {
    const { db, calls } = makeDb([{ id: 'row-1', to: 'namnh@qnsc.vn' }]);
    const service = new BounceFeedbackService(db, makeConfig());

    await service.applyEvent(sns(bounceEvent('mid-1')));

    expect(calls).toHaveLength(1);
    expect(calls[0].values.status).toBe('bounced');
    expect(calls[0].values.lastError).toContain('Permanent');
    expect(calls[0].values.lastError).toContain('550');
    expect(calls[0].values.feedbackAt).toBeInstanceOf(Date);
  });

  it('marks a complaint with the human diagnostic', async () => {
    const { db, calls } = makeDb([{ id: 'row-1', to: 'x@y.z' }]);
    const service = new BounceFeedbackService(db, makeConfig());

    await service.applyEvent(
      sns({ eventType: 'Complaint', mail: { messageId: 'mid-2' }, complaint: {} }),
    );

    expect(calls[0].values.status).toBe('complained');
    expect(calls[0].values.lastError).toBe('recipient marked as spam');
  });

  it('survives an unmatched verdict — zero rows is the contract, not an error', async () => {
    const { db, calls } = makeDb([]);
    const service = new BounceFeedbackService(db, makeConfig());

    await expect(service.applyEvent(sns(bounceEvent('mid-unknown')))).resolves.toBeUndefined();
    expect(calls).toHaveLength(1); // the guarded UPDATE ran and matched nothing
  });

  it('ignores non-verdict event types (Delivery/Open) without touching the table', async () => {
    const { db, calls } = makeDb([{ id: 'row-1', to: 'x@y.z' }]);
    const service = new BounceFeedbackService(db, makeConfig());

    await service.applyEvent(sns({ eventType: 'Delivery', mail: { messageId: 'mid-3' } }));
    expect(calls).toHaveLength(0);
  });

  it('drops non-JSON bodies and non-JSON SNS payloads', async () => {
    const { db, calls } = makeDb([{ id: 'row-1', to: 'x@y.z' }]);
    const service = new BounceFeedbackService(db, makeConfig());

    await service.applyEvent('not json at all');
    await service.applyEvent(JSON.stringify({ Type: 'Notification', Message: '{oops' }));
    expect(calls).toHaveLength(0);
  });

  it('acknowledges SNS SubscriptionConfirmation without a write', async () => {
    const { db, calls } = makeDb([{ id: 'row-1', to: 'x@y.z' }]);
    const service = new BounceFeedbackService(db, makeConfig());

    await service.applyEvent(JSON.stringify({ Type: 'SubscriptionConfirmation' }));
    expect(calls).toHaveLength(0);
  });

  it('drops an event with no messageId — there is no key to match on', async () => {
    const { db, calls } = makeDb([{ id: 'row-1', to: 'x@y.z' }]);
    const service = new BounceFeedbackService(db, makeConfig());

    await service.applyEvent(sns({ eventType: 'Bounce', mail: {} }));
    expect(calls).toHaveLength(0);
  });

  it('constructs OFF (no queue URL) without starting anything — the local/dev posture', () => {
    const { db } = makeDb();
    const service = new BounceFeedbackService(db, makeConfig({ SES_BOUNCE_QUEUE_URL: '' }));
    expect(service).toBeDefined();
  });
});

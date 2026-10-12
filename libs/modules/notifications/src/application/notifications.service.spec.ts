/**
 * Unit tests — NotificationsService
 *
 * Focuses on the idempotency guard (sourceEventId dedup) and delegation
 * to the repository for list/read operations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationsService } from './notifications.service';

const mockRepo = {
  existsBySourceEventId: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  unreadCount: vi.fn(),
};

const NOTIFICATION = {
  id: 'notif-1',
  recipientId: 'user-1',
  actorId: null,
  type: 'request.approved',
  title: 'Request approved',
  body: null,
  resourceType: 'request',
  resourceId: 'req-1',
  metadata: {},
  isRead: false,
  readAt: null,
  createdAt: new Date(),
  sourceEventId: 'evt-1',
};

function makeService() {
  return new NotificationsService(mockRepo as never);
}

describe('NotificationsService.send()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates and returns a notification when no duplicate', async () => {
    mockRepo.existsBySourceEventId.mockResolvedValue(false);
    mockRepo.create.mockResolvedValue(NOTIFICATION);

    const result = await makeService().send({
      recipientId: 'user-1',
      type: 'request.approved',
      title: 'Request approved',
      body: undefined,
      resourceType: 'request',
      resourceId: 'req-1',
      metadata: {},
      sourceEventId: 'evt-1',
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe('notif-1');
    expect(mockRepo.create).toHaveBeenCalledOnce();
  });

  it('returns null and skips create when sourceEventId already delivered (idempotency)', async () => {
    mockRepo.existsBySourceEventId.mockResolvedValue(true);

    const result = await makeService().send({
      recipientId: 'user-1',
      type: 'request.approved',
      title: 'Request approved',
      body: undefined,
      resourceType: 'request',
      resourceId: 'req-1',
      metadata: {},
      sourceEventId: 'evt-1',
    });

    expect(result).toBeNull();
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('skips dedup check when no sourceEventId provided', async () => {
    mockRepo.create.mockResolvedValue({ ...NOTIFICATION, sourceEventId: null });

    const result = await makeService().send({
      recipientId: 'user-1',
      type: 'request.approved',
      title: 'Request approved',
      body: undefined,
      resourceType: 'request',
      resourceId: 'req-1',
      metadata: {},
    });

    expect(mockRepo.existsBySourceEventId).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });
});

describe('NotificationsService.markRead()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to repository', async () => {
    mockRepo.markRead.mockResolvedValue(undefined);
    await makeService().markRead('notif-1', 'user-1');
    expect(mockRepo.markRead).toHaveBeenCalledWith('notif-1', 'user-1');
  });
});

describe('NotificationsService.unreadCount()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns count from repository', async () => {
    mockRepo.unreadCount.mockResolvedValue(7);
    const count = await makeService().unreadCount('user-1');
    expect(count).toBe(7);
  });
});

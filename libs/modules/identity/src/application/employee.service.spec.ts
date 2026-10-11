/**
 * Unit tests — EmployeeService
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';
import { EmployeeService } from './employee.service';
import { ConflictException, NotFoundException } from '@platform';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockEmployeeRepo = {
  findByEmail: vi.fn(),
  findById: vi.fn(),
  findExistingIds: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  updatePhoto: vi.fn(),
  list: vi.fn(),
};
const mockUsers = { ensure: vi.fn() };
const mockSessions = { offboard: vi.fn(), reinstate: vi.fn() };
const mockStorage = {
  presignUpload: vi.fn(),
  confirmUpload: vi.fn(),
  getDownloadUrl: vi.fn(),
  deleteFile: vi.fn(),
  findById: vi.fn(),
  findByKey: vi.fn(),
};
const mockAudit = createFakeAudit();

/**
 * A transaction that just runs its callback.
 *
 * The service now wraps each mutation and its audit write in one, so a spec that did not fake this would
 * construct fine and then fail at the first call — and faking it as a no-op would silently skip the body.
 */
const TX = { tx: true };
const mockDb = { transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX)) };

const ACTOR = { sub: 'admin-1', email: 'admin@acme.com' };

const EMPLOYEE = {
  id: 'emp-1',
  email: 'jane@acme.com',
  displayName: 'Jane Doe',
  department: 'Engineering',
  jobTitle: 'Engineer',
  managerId: null,
  roles: ['employee'],
  status: 'active' as const,
  entraOid: null,
  createdAt: new Date(),
};

function makeService(sessions: typeof mockSessions | null = mockSessions) {
  return new EmployeeService(
    mockEmployeeRepo as never,
    mockUsers as never,
    mockStorage as never,
    mockDb as never,
    mockAudit as never,
    sessions ?? undefined,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('EmployeeService.create()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an employee when email is unique', async () => {
    mockEmployeeRepo.findByEmail.mockResolvedValue(null);
    mockEmployeeRepo.create.mockResolvedValue(EMPLOYEE);

    const result = await makeService().create(
      { email: 'jane@acme.com', displayName: 'Jane Doe', roles: [] },
      ACTOR,
    );
    expect(result.email).toBe('jane@acme.com');
    // WITH THE TRANSACTION, which is the point: the entry commits with the row or not at all.
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'employee.created' }),
      TX,
    );
    expect(mockEmployeeRepo.create).toHaveBeenCalledWith(expect.anything(), TX);
    // The identity user is written in the SAME transaction, with the employee's id: otherwise the
    // person's first Microsoft sign-in would create a user with a new id.
    expect(mockUsers.ensure).toHaveBeenCalledWith(EMPLOYEE, TX);
  });

  it('lowercases email before checking uniqueness', async () => {
    mockEmployeeRepo.findByEmail.mockResolvedValue(null);
    mockEmployeeRepo.create.mockResolvedValue({ ...EMPLOYEE, email: 'jane@acme.com' });

    await makeService().create({ email: 'JANE@ACME.COM', displayName: 'Jane', roles: [] }, ACTOR);
    expect(mockEmployeeRepo.findByEmail).toHaveBeenCalledWith('jane@acme.com');
  });

  it('throws ConflictException when email already exists', async () => {
    mockEmployeeRepo.findByEmail.mockResolvedValue(EMPLOYEE);
    await expect(
      makeService().create({ email: 'jane@acme.com', displayName: 'Jane', roles: [] }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mockEmployeeRepo.create).not.toHaveBeenCalled();
  });
});

describe('EmployeeService.getById()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns employee when found', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(EMPLOYEE);
    const result = await makeService().getById('emp-1');
    expect(result.id).toBe('emp-1');
  });

  it('throws NotFoundException when not found', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(null);
    await expect(makeService().getById('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EmployeeService.update()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates allowed fields and records audit', async () => {
    const updated = { ...EMPLOYEE, displayName: 'Jane Smith', jobTitle: 'Lead' };
    mockEmployeeRepo.findById.mockResolvedValue(EMPLOYEE);
    mockEmployeeRepo.update.mockResolvedValue(updated);

    const result = await makeService().update(
      'emp-1',
      { displayName: 'Jane Smith', jobTitle: 'Lead' },
      ACTOR,
    );
    expect(result.displayName).toBe('Jane Smith');
    expect(mockUsers.ensure).toHaveBeenCalledWith(updated, TX); // the identity user follows
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'employee.updated' }),
      TX,
    );
  });

  it('throws NotFoundException when employee does not exist', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(null);
    await expect(makeService().update('ghost', { displayName: 'X' }, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('EmployeeService.updateStatus()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates status and emits audit', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(EMPLOYEE);
    mockEmployeeRepo.updateStatus.mockResolvedValue({ ...EMPLOYEE, status: 'on_leave' });

    const result = await makeService().updateStatus('emp-1', 'on_leave', ACTOR);
    expect(result.status).toBe('on_leave');
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'employee.status_changed' }),
      TX,
    );
  });

  it('returns existing employee without DB call when status unchanged', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(EMPLOYEE); // already 'active'
    const result = await makeService().updateStatus('emp-1', 'active', ACTOR);
    expect(result.status).toBe('active');
    expect(mockEmployeeRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('ends the sessions and blocks sign-in when offboarded, AFTER the commit', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(EMPLOYEE);
    mockEmployeeRepo.updateStatus.mockResolvedValue({ ...EMPLOYEE, status: 'offboarded' });
    const order: string[] = [];
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn(TX);
      order.push('commit');
      return result;
    });
    mockSessions.offboard.mockImplementation(() => {
      order.push('offboard');
      return Promise.resolve();
    });

    await makeService().updateStatus('emp-1', 'offboarded', ACTOR);

    expect(mockSessions.offboard).toHaveBeenCalledWith('emp-1', 'offboarded');
    expect(order).toEqual(['commit', 'offboard']);
  });

  it('allows sign-in again when an offboarded employee is re-activated, or put on leave', async () => {
    for (const status of ['active', 'on_leave'] as const) {
      vi.clearAllMocks();
      mockEmployeeRepo.findById.mockResolvedValue({ ...EMPLOYEE, status: 'offboarded' });
      mockEmployeeRepo.updateStatus.mockResolvedValue({ ...EMPLOYEE, status });
      await makeService().updateStatus('emp-1', status, ACTOR);
      expect(mockSessions.reinstate).toHaveBeenCalledWith('emp-1');
      expect(mockSessions.offboard).not.toHaveBeenCalled();
    }
  });

  it('touches no session for a change that is not into or out of offboarded', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(EMPLOYEE);
    mockEmployeeRepo.updateStatus.mockResolvedValue({ ...EMPLOYEE, status: 'on_leave' });
    await makeService().updateStatus('emp-1', 'on_leave', ACTOR);
    expect(mockSessions.offboard).not.toHaveBeenCalled();
    expect(mockSessions.reinstate).not.toHaveBeenCalled();
  });

  it('fails loudly where no SessionRevoker is bound (the worker) rather than skipping the revocation', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(EMPLOYEE);
    mockEmployeeRepo.updateStatus.mockResolvedValue({ ...EMPLOYEE, status: 'offboarded' });
    await expect(makeService(null).updateStatus('emp-1', 'offboarded', ACTOR)).rejects.toThrow(
      /SessionRevoker/,
    );
  });
});

describe('EmployeeService.confirmAvatar()', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * REPLACING an avatar looked up the previous file BY KEY through a by-ID finder.
   *
   * `employees.photo_storage_key` holds the S3 key; `findById` queries a uuid column. Postgres answered
   * `invalid input syntax for type uuid: "employee-avatar/…png"`, so every second upload for the same
   * employee was a 500 — while the first one worked, because the old-file branch was skipped. Measured
   * from a browser, and invisible until a test uploaded twice.
   */
  it('finds the old file by KEY, not by id', async () => {
    const key = 'employee-avatar/emp-1/019ff173-0a13-7395-8405-5a39fe44d8ff.png';
    mockEmployeeRepo.findById.mockResolvedValue({ ...EMPLOYEE, photoStorageKey: key });
    mockStorage.confirmUpload.mockResolvedValue({ key: 'new/key.png', url: 'https://x/new' });
    mockStorage.findByKey.mockResolvedValue({ id: 'file-1', uploaderId: 'admin-1' });

    await makeService().confirmAvatar('emp-1', 'file-2', ACTOR);

    expect(mockStorage.findByKey).toHaveBeenCalledWith(key);
    // The id finder must not be reached with a key — that call is the defect itself.
    expect(mockStorage.findById).not.toHaveBeenCalled();
    expect(mockStorage.deleteFile).toHaveBeenCalledWith('file-1', 'admin-1');
  });

  it('skips the old-file lookup for an employee with no avatar yet', async () => {
    mockEmployeeRepo.findById.mockResolvedValue({ ...EMPLOYEE, photoStorageKey: null });
    mockStorage.confirmUpload.mockResolvedValue({ key: 'new/key.png', url: 'https://x/new' });

    await makeService().confirmAvatar('emp-1', 'file-2', ACTOR);

    expect(mockStorage.findByKey).not.toHaveBeenCalled();
    expect(mockStorage.deleteFile).not.toHaveBeenCalled();
  });

  /*
   * `assertExist` — the reference guard that thirty-four call sites open-coded.
   *
   * These references are CROSS-SCHEMA and by design carry no foreign key, so this is the only thing
   * standing between a typo'd uuid and a risk owned by nobody. The properties worth pinning are
   * therefore: it refuses when an id is missing, it says WHICH ones, it does not go to the database
   * when there is nothing to check, and one query covers every reference.
   */
  describe('assertExist', () => {
    it('names every missing id, not the first one it hit', async () => {
      // The old form fetched one row per reference and threw on the first, so a form with a bad owner
      // AND a bad custodian reported one of them and failed again on the next submit.
      mockEmployeeRepo.findExistingIds.mockResolvedValue(['emp-1']);

      await expect(makeService().assertExist('emp-1', 'ghost-a', 'ghost-b')).rejects.toThrow(
        /ghost-a, ghost-b/,
      );
    });

    it('resolves when every id is real', async () => {
      mockEmployeeRepo.findExistingIds.mockResolvedValue(['emp-1', 'emp-2']);
      await expect(makeService().assertExist('emp-1', 'emp-2')).resolves.toBeUndefined();
    });

    it('checks every reference in ONE query', async () => {
      mockEmployeeRepo.findExistingIds.mockResolvedValue(['emp-1', 'emp-2']);

      await makeService().assertExist('emp-1', 'emp-2');

      expect(mockEmployeeRepo.findExistingIds).toHaveBeenCalledTimes(1);
      expect(mockEmployeeRepo.findExistingIds).toHaveBeenCalledWith(['emp-1', 'emp-2']);
    });

    it('skips nullish ids, so an optional field needs no `if` around the call', async () => {
      mockEmployeeRepo.findExistingIds.mockResolvedValue(['emp-1']);

      await makeService().assertExist('emp-1', null, undefined);

      // Twelve call sites wrapped the old call in `if (dto.custodianId)`. The skip lives here now, so
      // the guard reads the same whether the column is nullable or not.
      expect(mockEmployeeRepo.findExistingIds).toHaveBeenCalledWith(['emp-1']);
    });

    it('does not touch the database when there is nothing to check', async () => {
      // An update DTO where every reference is absent. Passing nothing is not an error — it means
      // there was nothing to validate — and it must not cost a round trip or an empty `IN ()`.
      await expect(makeService().assertExist(null, undefined)).resolves.toBeUndefined();
      expect(mockEmployeeRepo.findExistingIds).not.toHaveBeenCalled();
    });

    it('asks about a repeated id once', async () => {
      // A reviewer reassigned to the employee's own manager, say: the same uuid twice in one call.
      mockEmployeeRepo.findExistingIds.mockResolvedValue(['emp-1']);

      await makeService().assertExist('emp-1', 'emp-1');

      expect(mockEmployeeRepo.findExistingIds).toHaveBeenCalledWith(['emp-1']);
    });

    it('refuses with EMPLOYEE_NOT_FOUND, the code the old call threw', async () => {
      // The status code and the error code are part of the contract: the SPA maps this to "that person
      // does not exist", and a different code would render as a generic failure.
      mockEmployeeRepo.findExistingIds.mockResolvedValue([]);
      await expect(makeService().assertExist('ghost')).rejects.toThrow(NotFoundException);
    });
  });
});

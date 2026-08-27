// @vitest-environment jsdom
/**
 * THE SELF-SERVICE UPLOAD, and the entry point that was never built.
 *
 * WHY A COMPONENT TEST. All eight Playwright seats are administrators holding `training.manage`, so the
 * browser suite can only ever exercise this flow as somebody who did not need it. The tier this tab was
 * written for — `ROLE.EMPLOYEE`, which holds NO permission code at all — is not constructible from
 * there, and that is precisely how the gap survived: the API's `assertMayAttach` has permitted "an
 * employee may attach evidence to their OWN record" since the module shipped, and the only
 * `CertificatesPanel` in the product sat behind the Records tab, which needs `training.read`. The flow
 * existed, was authorized, was rate-limited, was covered by an e2e — and had no button.
 *
 * THE RULE, READ FROM THE ROUTE RATHER THAN GUESSED. `assertMayAttach` in the training controller:
 *   const record = await this.service.getRecord(recordId);
 *   if (record.employeeId === user.sub) return false;   // own record: allowed, no permission
 *   if (await this.canManage(user)) return true;
 *   throw new PermissionDeniedException(…)
 * Ownership OR `training.manage`, and `GET …/certificates` runs through the same check — so it governs
 * the LIST as well as the buttons. Both halves are asserted below: gate the own-record upload on a
 * permission and the first case fails; drop the ownership comparison and the second one does.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: vi.fn(), DELETE: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The upload chain is a presign, a PUT and a confirm; none of it runs here, and whether the Attach
// control is OFFERED is the whole question.
vi.mock('@/shared/api/use-upload', () => ({
  useUpload: () => ({ upload: vi.fn(), uploading: false }),
}));

import { useAuthStore } from '@/shared/api/auth-store';
import { MyTrainingTab } from './my-training-tab';

const ME = '019fff6b-0000-7fac-8f5e-000000000001';
const SOMEBODY_ELSE = '019fff6b-0000-7fac-8f5e-000000000002';

const COURSE = {
  id: 'course-1',
  code: 'ISO-27001-AW',
  title: 'Information Security Awareness',
  category: 'compliance',
  provider: 'Internal',
  validityMonths: 12,
  retiredAt: null,
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-01-05T09:00:00.000Z',
};

// Widened where a case substitutes a different value, for the reason `records-tab.spec.tsx` widens the
// same fields: TypeScript otherwise infers the literal `'valid'` and refuses the spread override.
const MY_RECORD = {
  id: 'rec-1',
  employeeId: ME,
  employeeName: 'Me',
  courseId: 'course-1',
  completedOn: '2026-02-10',
  expiresOn: '2027-02-10',
  result: 'pass',
  score: '88',
  status: 'valid' as string,
  verifiedAt: null as string | null,
  verifiedBy: null as string | null,
  revokedReason: null as string | null,
  supersededById: null,
  notes: null,
  createdAt: '2026-02-10T09:00:00.000Z',
};

const CERTIFICATE = {
  fileId: 'file-1',
  fileName: 'awareness-certificate.pdf',
  sizeBytes: 24_576,
  attachedAt: '2026-02-11T09:00:00.000Z',
};

/** One GET mock routed on the path: this tab reads three endpoints, and the drawer adds a fourth. */
function routeGet(record: Record<string, unknown>) {
  GET.mockImplementation((path: string) => {
    if (path === '/v1/training/me') return Promise.resolve({ data: [record], error: undefined });
    // No outstanding gaps. The gap table is the other half of this tab and contributes nothing to an
    // upload question; an empty list keeps its rows out of the queries below.
    if (path === '/v1/training/me/gaps') return Promise.resolve({ data: [], error: undefined });
    if (path === '/v1/training/courses') {
      return Promise.resolve({
        data: { data: [COURSE], pageInfo: { total: 1, limit: 100, offset: 0, hasNextPage: false } },
        error: undefined,
      });
    }
    if (path === '/v1/training/records/{id}/certificates') {
      return Promise.resolve({ data: [CERTIFICATE], error: undefined });
    }
    return Promise.resolve({ data: undefined, error: { message: `unrouted ${path}` } });
  });
}

function renderTab(record: Record<string, unknown> = MY_RECORD) {
  routeGet(record);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MyTrainingTab />
    </QueryClientProvider>,
  );
}

/** Open the record's drawer. `data-row-id` is the handle `DataTable` exposes for exactly this. */
async function openDrawer(container: HTMLElement) {
  await screen.findByText('Information Security Awareness');
  fireEvent.click(container.querySelector('[data-row-id="rec-1"]')!);
  await screen.findByText('Certificates');
}

describe('MyTrainingTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /*
     * A PERMISSION-LESS EMPLOYEE — the tier that cannot be seated in Playwright. `permissions: []` and
     * `roles: []` is the whole point: nothing below may pass because the reader happened to hold a code.
     * The real store rather than a mock, because the ownership comparison reads `user.sub` from it and a
     * mock would let some other field satisfy the assertion.
     */
    useAuthStore.setState({
      user: { sub: ME, email: 'me@example.com', name: 'Me', roles: [], permissions: [] },
    });
  });

  it('offers an entry point to the upload at all — the defect was that there was none', async () => {
    const { container } = renderTab();

    // The tile the tab used to end at. It counts records, so it can say "you hold one certificate" while
    // offering no way to put one on file; its presence is not the entry point and never was.
    expect(await screen.findByText('Current certificates')).toBeTruthy();
    // The row has to ANNOUNCE that it opens. A clickable row is silent, so the sentence is the affordance.
    expect(screen.getByText(/Open a row to attach your certificate/)).toBeTruthy();

    await openDrawer(container);
    expect(screen.getByRole('button', { name: /Attach certificate/ })).toBeTruthy();
  });

  it('lets an employee holding no permission attach evidence to their OWN record', async () => {
    /*
     * THE ORDINARY FLOW, and the one the API was built for. `assertMayAttach` returns on the ownership
     * branch BEFORE it consults `training.manage`, so no code is involved — the record already names who
     * it belongs to. Gate this on a permission and the tab is back to being useful only to the
     * administrators who never needed it, which is the same defect wearing a check.
     */
    const { container } = renderTab();
    await openDrawer(container);

    expect(screen.getByRole('button', { name: /Attach certificate/ })).toBeTruthy();
    /*
     * And the LIST was fetched, which is half the rule: `GET …/certificates` is behind the same
     * `assertMayAttach`, so an owner who may attach may also enumerate. The panel skips the request
     * entirely when it believes it may not, so a passing button assertion with no list would mean the
     * two halves had been decided differently.
     */
    expect(await screen.findByText(CERTIFICATE.fileName)).toBeTruthy();
    // Their own evidence, theirs to remove and theirs to read back. Still no permission code held.
    expect(screen.getByRole('button', { name: `Delete ${CERTIFICATE.fileName}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Download ${CERTIFICATE.fileName}` })).toBeTruthy();
  });

  it('withholds the upload on a record that is not the caller’s, and says why', async () => {
    /*
     * `GET /v1/training/me` is `@SelfScoped`, so a foreign row SHOULD never arrive here — which is
     * exactly why the gate is asserted rather than assumed. `canPost` is a claim about this reader and
     * this record, and passing a bare `true` because the endpoint is self-scoped would be the same
     * mistake as the `canManage={status !== 'revoked'}` this panel was split apart to fix: a prop that
     * looked like a check and was an assumption. Drop the `employeeId === me.sub` comparison and this is
     * the case that fails.
     */
    const { container } = renderTab({ ...MY_RECORD, employeeId: SOMEBODY_ELSE });
    await openDrawer(container);

    expect(screen.queryByRole('button', { name: /Attach certificate/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: `Delete ${CERTIFICATE.fileName}` }),
      'deleting evidence from a record that is not yours needs training.manage',
    ).toBeNull();
    expect(screen.getByText(/visible to training administrators only/)).toBeTruthy();
    // Never requested, rather than requested and refused: a 403 rendered as "failed to load" would blame
    // the network for a permission.
    expect(GET).not.toHaveBeenCalledWith(
      '/v1/training/records/{id}/certificates',
      expect.anything(),
    );
  });

  it('stops taking new evidence once the record is revoked, without hiding what is on file', async () => {
    /*
     * LIFECYCLE, NOT AUTHORIZATION. This is the caller's own record and they may certainly write to it;
     * the reason Attach is gone has nothing to do with who they are. Unlike when this panel was written,
     * the server now agrees — `presignCertificate` and `confirmCertificate` both refuse a revoked record
     * with `TRAINING_RECORD_NOT_VERIFIABLE` — so the panel's job here is to withhold the button and give
     * the reason instead of letting an employee discover a 412 after choosing a file.
     */
    const { container } = renderTab({
      ...MY_RECORD,
      status: 'revoked',
      revokedReason: 'certificate forged',
    });
    await openDrawer(container);

    expect(screen.queryByRole('button', { name: /Attach certificate/ })).toBeNull();
    expect(screen.getByText(/takes no further evidence/)).toBeTruthy();
    // The reason is shown to the person it is about; a revocation they cannot see is one they cannot
    // dispute.
    expect(screen.getByText('certificate forged')).toBeTruthy();

    // BUT THE EVIDENCE IS STILL LISTED AND STILL DOWNLOADABLE — the service leaves `listCertificates` and
    // `certificateDownloadUrl` unguarded for the same reason: an audit asks what was on file at the time.
    expect(await screen.findByText(CERTIFICATE.fileName)).toBeTruthy();
    expect(screen.getByRole('button', { name: `Download ${CERTIFICATE.fileName}` })).toBeTruthy();
  });

  it('leaves the audit trail out of this drawer, because the reader may not read it', async () => {
    /*
     * `ActivityTimeline` fetches `GET /v1/audit-logs`, which carries `@RequirePermission('audit.read')`.
     * An employee does not hold it, so copying the Records tab's drawer wholesale would have put an
     * "Activity" heading above a permanent failure on the one tab written for people holding nothing.
     * `EntityDetailPanel` omits the section when `activity` is absent, and this is the assertion that
     * keeps it absent.
     */
    const { container } = renderTab();
    await openDrawer(container);

    expect(screen.queryByText('Activity')).toBeNull();
    expect(GET).not.toHaveBeenCalledWith('/v1/audit-logs', expect.anything());
  });
});

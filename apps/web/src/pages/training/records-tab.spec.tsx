// @vitest-environment jsdom
/**
 * WHO MAY ATTEST TO COMPETENCY EVIDENCE, and the bug that hid inside a boolean.
 *
 * WHY A COMPONENT TEST. All eight Playwright seats are administrators holding `training.manage`, so the
 * browser suite only ever renders the write tier of this tab. The read tier — `ROLE.MANAGER` and
 * `ROLE.AUDITOR`, both of which hold `training.read` and neither of which holds `training.manage` — is
 * structurally unreachable from there, and that is exactly why three ungated controls and one disguised
 * one survived on the most audit-sensitive screen in the module.
 *
 * THE ROUTES, READ RATHER THAN GUESSED FROM THE NAMES, because they are not all the same rule:
 *   · `POST /training/records`, `POST /training/records/{id}/verify` and
 *     `POST /training/records/{id}/revoke` are `@RequirePermission('training.manage')`. Verify is the
 *     ISO control: a second person saying they saw the evidence. An auditor offered Verify is an
 *     auditor attesting to what they are auditing.
 *   · The certificate routes are NOT the same rule. `assertMayAttach` in the training controller
 *     authorizes on OWNERSHIP OR the manage code — "an employee may attach evidence to their OWN
 *     record; anyone else needs training.manage" — and `GET …/certificates` runs through the same
 *     check, so it governs the list and not only the buttons.
 *
 * AND THE BUG THIS FILE EXISTS FOR. `CertificatesPanel` used to be handed
 * `canManage={selected.status !== 'revoked'}`: a STATUS expression in a PERMISSION prop. It looked like
 * a check, it read like a check, and it granted Attach and Delete to every holder of `training.read` on
 * anybody's record — while simultaneously making "writable but revoked" inexpressible, because one
 * boolean cannot say two things. The last two cases below hold both halves apart: pass a status
 * expression back into `canPost` and the read-only case fails; drop `frozen` and the revoked case fails.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: vi.fn(), DELETE: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The upload chain is a presign, a PUT and a confirm; none of it runs here, and the Attach button's
// mere presence is the whole question.
vi.mock('@/shared/api/use-upload', () => ({
  useUpload: () => ({ upload: vi.fn(), uploading: false }),
}));

/** Exact-key matching, so a component gating on some other permission cannot pass by accident. */
let held: string[] = [];
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (key: string) => held.includes(key) }),
}));

// The filter pickers fetch employees and courses of their own and contribute nothing to a permission
// question; stubbed so the assertions below are about buttons this tab owns.
vi.mock('@/shared/ui', async () => {
  const real = await vi.importActual<typeof import('@/shared/ui')>('@/shared/ui');
  return { ...real, EntityPicker: () => null };
});

import { useAuthStore } from '@/shared/api/auth-store';
import { RecordsTab } from './records-tab';

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

// The fields cases below override are widened, so a spread can substitute a revoked record. Without the
// annotations TypeScript infers `'valid'` and `null` as the literal types and refuses the override.
const RECORD = {
  id: 'rec-1',
  employeeId: SOMEBODY_ELSE,
  employeeName: 'Dana Okonkwo',
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

/** One GET mock routed on the path, because this tab reads four endpoints to render one drawer. */
function routeGet(record: Record<string, unknown>) {
  GET.mockImplementation((path: string) => {
    if (path === '/v1/training/records') {
      return Promise.resolve({
        data: { data: [record], pageInfo: { total: 1, limit: 25, offset: 0, hasNextPage: false } },
        error: undefined,
      });
    }
    if (path === '/v1/training/courses') {
      return Promise.resolve({
        data: { data: [COURSE], pageInfo: { total: 1, limit: 100, offset: 0, hasNextPage: false } },
        error: undefined,
      });
    }
    if (path === '/v1/training/records/{id}/certificates') {
      return Promise.resolve({ data: [CERTIFICATE], error: undefined });
    }
    // The drawer's activity timeline. Empty, so it renders nothing and stays out of the way.
    return Promise.resolve({
      data: { data: [], pageInfo: { total: 0, limit: 25, offset: 0, hasNextPage: false } },
      error: undefined,
    });
  });
}

function renderAs(permissions: string[], record = RECORD) {
  held = permissions;
  routeGet(record);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecordsTab />
    </QueryClientProvider>,
  );
}

/** Open the record's drawer. `data-row-id` is the handle `DataTable` exposes for exactly this. */
async function openDrawer(container: HTMLElement) {
  await screen.findByText('Dana Okonkwo');
  fireEvent.click(container.querySelector('[data-row-id="rec-1"]')!);
  await screen.findByText('Certificates');
}

describe('RecordsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The signed-in principal. The real store rather than a mock, because the ownership half of the
    // certificate rule is read from it and a mock would let the wrong field satisfy the test.
    useAuthStore.setState({
      user: { sub: ME, email: 'me@example.com', name: 'Me', roles: [], permissions: [] },
    });
  });

  it('shows the register but offers no attestation to a training.read-only holder', async () => {
    renderAs(['training.read']);

    /*
     * The register itself must render. An auditor reading who is trained in what is the legitimate use
     * of `training.read`, and a "fix" that hid the table would pass every negative assertion below
     * while destroying the tab's purpose.
     */
    expect(await screen.findByText('Dana Okonkwo')).toBeTruthy();
    expect(screen.getByText('Information Security Awareness')).toBeTruthy();
    // "Not verified" is a fact this reader is entitled to, and is the column an audit actually reads.
    expect(screen.getByText('Not verified')).toBeTruthy();

    /*
     * None of the three `training.manage` routes is offered. Verify is the one that matters most: it is
     * a second-person attestation, so an auditor holding it collapses the separation the route's own
     * docblock exists to create.
     */
    expect(screen.queryByRole('button', { name: 'Record completion' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Verify' }),
      'verifying is the ISO control: whoever attests must not be whoever is auditing',
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('offers record, verify and revoke to a training.manage holder', async () => {
    renderAs(['training.read', 'training.manage']);

    await screen.findByText('Dana Okonkwo');
    /*
     * The positive half. Without it, deleting the three controls outright would satisfy the case above,
     * so this is what makes the pair a gate rather than a removal.
     */
    expect(screen.getByRole('button', { name: 'Record completion' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });

  it('keeps the lifecycle rules on a record a manage holder may write', async () => {
    renderAs(['training.read', 'training.manage'], {
      ...RECORD,
      status: 'revoked',
      revokedReason: 'certificate forged',
    });

    await screen.findByText('Dana Okonkwo');
    /*
     * PERMISSION AND STATE ARE SEPARATE AXES, and adding the first must not have swallowed the second.
     * A revoked record cannot be verified and cannot be revoked twice — the service refuses both by
     * name — so a rewrite that replaced the status conditions with the permission check would put two
     * buttons on this row whose only possible outcome is an error message.
     */
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    // The manage holder is still a manage holder: the tab-level action is unaffected by one row's state.
    expect(screen.getByRole('button', { name: 'Record completion' })).toBeTruthy();
  });

  it('withholds a stranger’s certificates from a read-only holder, and says why', async () => {
    const { container } = renderAs(['training.read']);
    await openDrawer(container);

    /*
     * THE CASE THE OLD `canManage={selected.status !== 'revoked'}` FAILED. This record belongs to
     * somebody else and this caller holds no manage code, so `assertMayAttach` refuses them — yet the
     * status expression evaluated to `true` on a valid record and handed them both write controls.
     * Reinstate a status expression here and this assertion is the one that fails.
     */
    expect(screen.queryByRole('button', { name: /Attach certificate/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: `Delete ${CERTIFICATE.fileName}` }),
      'deleting evidence from a record that is not yours needs training.manage',
    ).toBeNull();

    /*
     * SAID, NOT LEFT BLANK. `GET …/certificates` is behind the same check, so this reader gets no list
     * either — and an empty Certificates section is indistinguishable from a completion with no
     * evidence at all, which is a compliance gap that is not there. Naming the reason is what stops a
     * reader inventing the wrong one.
     */
    expect(screen.getByText(/visible to training administrators only/)).toBeTruthy();
    // And the request was never made, rather than made and refused: a 403 rendered as "failed to load"
    // would blame the network for a permission.
    expect(GET).not.toHaveBeenCalledWith(
      '/v1/training/records/{id}/certificates',
      expect.anything(),
    );
  });

  it('lets an employee attach evidence to their OWN record with no permission at all', async () => {
    /*
     * THE SELF-SCOPED HALF, and the reason `canPost` is not simply `canManage`. Uploading the
     * certificate for a course you took is the ordinary flow and needs no permission code — the record
     * already names who it belongs to, which is precisely what `assertMayAttach` checks first. Gating
     * this on the manage code would have fixed the leak by breaking the common case, a new defect of
     * the same kind, and nothing else in this file would have noticed.
     */
    const { container } = renderAs([], { ...RECORD, employeeId: ME, employeeName: 'Me' });
    await screen.findByText('Me');
    fireEvent.click(container.querySelector('[data-row-id="rec-1"]')!);
    await screen.findByText('Certificates');

    expect(screen.getByRole('button', { name: /Attach certificate/ })).toBeTruthy();
    // Awaited, because the list is a second request the drawer fires on open — and the fact that it
    // WAS fired is half the assertion: an owner may enumerate their own evidence.
    expect(await screen.findByText(CERTIFICATE.fileName)).toBeTruthy();
    // Their own evidence, theirs to remove. Still no permission code held.
    expect(screen.getByRole('button', { name: `Delete ${CERTIFICATE.fileName}` })).toBeTruthy();
    // And an owner is not thereby an attester: verify remains `training.manage`.
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('stops taking new evidence once a record is revoked, without hiding what is on file', async () => {
    /*
     * THE OTHER HALF OF THE OLD BOOLEAN, now able to speak for itself. `frozen` is lifecycle, not
     * authorization: this caller holds `training.manage` and may certainly write to this record, and
     * the reason Attach is gone has nothing to do with who they are. The API does NOT enforce this —
     * the service refuses a verify or a revoke on a revoked record but not a presign — so it is an
     * editorial rule, and drop the `frozen` prop and this is the assertion that catches it.
     */
    const { container } = renderAs(['training.read', 'training.manage'], {
      ...RECORD,
      status: 'revoked',
      revokedReason: 'certificate forged',
    });
    await openDrawer(container);

    expect(screen.queryByRole('button', { name: /Attach certificate/ })).toBeNull();
    expect(screen.getByText(/takes no further evidence/)).toBeTruthy();

    /*
     * BUT THE EVIDENCE IS STILL LISTED AND STILL DOWNLOADABLE. An audit asks what was on file at the
     * time, so revoking a record must not make its history unreadable — a `frozen` that also hid the
     * list would answer that question with nothing.
     */
    expect(await screen.findByText(CERTIFICATE.fileName)).toBeTruthy();
    expect(screen.getByRole('button', { name: `Download ${CERTIFICATE.fileName}` })).toBeTruthy();
  });
});

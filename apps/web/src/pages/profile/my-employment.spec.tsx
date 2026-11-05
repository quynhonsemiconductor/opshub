// @vitest-environment jsdom
/**
 * Your own employment record, on your own profile.
 *
 * WHAT THESE PIN. `/v1/roles/me` and `/v1/contracts/me` are `@SelfScoped` — no id, no permission — and
 * neither had a caller, so an employee could not see their own role history or contract anywhere. The
 * assertion that matters is that a role reads as a TITLE: the API resolves `roleCode`/`roleTitle`
 * server-side precisely because a self-scoped caller holds no `role.read` to look one up, and rendering
 * the raw `roleId` is the failure this replaced.
 *
 * AN EMPTY LIST IS AN ONBOARDING GAP, not an error — somebody on the register occupying no approved seat is
 * what the headcount reports are about — so it says so rather than rendering nothing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
vi.mock('@/shared/api/client', () => ({ api: { GET: (...a: unknown[]) => GET(...a) } }));

import { MyContracts, MyRoleHistory } from './my-employment';

const ROLE = {
  id: 'ep-1',
  employeeId: 'emp-1',
  roleId: '019fff6b-855d-7fac-8f5e-f79f4fec0bc3',
  roleCode: 'ENG-002',
  roleTitle: 'Senior Platform Engineer',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  endReason: null,
  createdAt: '2026-01-01T09:00:00.000Z',
};

const CONTRACT = {
  id: 'c-1',
  employeeId: 'emp-1',
  roleId: null,
  reference: 'EMP-2026-0042',
  contractType: 'permanent',
  startDate: '2026-01-01',
  endDate: null,
  probationEndDate: '2026-04-01',
  noticePeriodDays: 30,
  status: 'active',
  signedAt: '2025-12-20T09:00:00.000Z',
  documentId: null,
  terminatedOn: null,
  terminationReason: null,
  supersededById: null,
  notes: null,
  createdAt: '2025-12-20T09:00:00.000Z',
};

function renderIn(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('MyRoleHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the role rather than printing the id it used to be handed', async () => {
    GET.mockResolvedValue({ data: [ROLE], error: undefined });
    renderIn(<MyRoleHistory />);

    expect(await screen.findByText('Senior Platform Engineer')).toBeTruthy();
    expect(screen.getByText('ENG-002')).toBeTruthy();
    // The UUID must NOT be on screen. Before the API resolved the title this was the only thing a
    // self-scoped caller could render, and it tells the reader nothing.
    expect(screen.queryByText(ROLE.roleId)).toBeNull();
  });

  it('reads an open assignment as current, not as a blank end date', async () => {
    GET.mockResolvedValue({ data: [ROLE], error: undefined });
    renderIn(<MyRoleHistory />);
    // `effectiveTo: null` means "still holding it" — an em dash to nowhere would read as missing data.
    expect(await screen.findByText(/1 Jan 2026 — now/)).toBeTruthy();
    /*
     * AND NO END REASON, because an open assignment has not ended. A badge here would invent a reason for a
     * role somebody still holds — caught by mutation: rendering the badge unconditionally passed every other
     * assertion in this file.
     */
    expect(screen.queryByText(/transfer|departure|none/i)).toBeNull();
  });

  it('shows the end reason only on a closed row', async () => {
    GET.mockResolvedValue({
      data: [{ ...ROLE, effectiveTo: '2026-06-30', endReason: 'internal_transfer' }],
      error: undefined,
    });
    renderIn(<MyRoleHistory />);
    // The reason is what separates a promotion from a departure.
    expect(await screen.findByText('Internal transfer')).toBeTruthy();
  });

  it('names an empty history as an onboarding gap', async () => {
    GET.mockResolvedValue({ data: [], error: undefined });
    renderIn(<MyRoleHistory />);
    expect(await screen.findByText('No role on record yet')).toBeTruthy();
  });
});

describe('MyContracts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the reference, type, status and the notice period somebody looks this up for', async () => {
    GET.mockResolvedValue({ data: [CONTRACT], error: undefined });
    renderIn(<MyContracts />);

    expect(await screen.findByText('EMP-2026-0042')).toBeTruthy();
    expect(screen.getByText('Permanent')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText(/30 days notice/)).toBeTruthy();
    // Open-ended, not a blank: a permanent contract has no end date and that is the point of it.
    expect(screen.getByText(/open-ended/)).toBeTruthy();
    expect(screen.getByText(/Probation ends 1 Apr 2026/)).toBeTruthy();
  });

  it('names an empty list rather than rendering nothing', async () => {
    GET.mockResolvedValue({ data: [], error: undefined });
    renderIn(<MyContracts />);
    expect(await screen.findByText('No contract on record yet')).toBeTruthy();
  });
});

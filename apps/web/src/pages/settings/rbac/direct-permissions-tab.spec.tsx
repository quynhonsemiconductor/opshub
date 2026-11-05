// @vitest-environment jsdom
/**
 * The Direct permissions tab — who may grant outside a group, and what the grant form refuses.
 *
 * Granting a permission to one employee bypasses the groups, so it is the most sensitive write on the access
 * control screen. Two things are asserted here because a browser run cannot: that a reader who only holds
 * `rbac.read` sees the lookup but no write control (every Playwright seat is an admin, so that tier cannot be
 * represented there), and that the form says what is missing before it asks the API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const caller = vi.hoisted(() => ({ permissions: [] as string[] }));

const GET = vi.fn();
const POST = vi.fn();
const DELETE = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    POST: (...a: unknown[]) => POST(...a),
    DELETE: (...a: unknown[]) => DELETE(...a),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (perm: string) => caller.permissions.includes(perm) }),
}));

import { DirectPermissionsTab } from './direct-permissions-tab';

const _EMPLOYEE = {
  id: '019fff6b-855d-7fac-8f5e-f79f4fec0bc3',
  displayName: 'Alice Nguyen',
  department: 'Compliance',
  email: 'alice@example.com',
};

const _GRANT = {
  id: 'grant-1',
  employeeId: _EMPLOYEE.id,
  permissionKey: 'door.manage',
  scopeType: 'global',
  scopeId: null,
  grantedBy: 'admin',
  reason: 'covering the front desk',
  expiresAt: null,
  createdAt: '2026-11-01T09:00:00.000Z',
};

const _CATALOGUE = [
  { key: 'door.manage', description: 'Manage doors' },
  { key: 'asset.read', description: 'Read assets' },
];

function routeReads() {
  GET.mockImplementation((path: string) => {
    if (path === '/v1/employees') return Promise.resolve({ data: { data: [_EMPLOYEE] } });
    if (path === '/v1/authz/employees/{employeeId}/permissions')
      return Promise.resolve({ data: [_GRANT] });
    if (path === '/v1/authz/permissions') return Promise.resolve({ data: _CATALOGUE });
    return Promise.resolve({ data: [] });
  });
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DirectPermissionsTab />
    </QueryClientProvider>,
  );
}

/** Pick the employee in the tab's own picker, which is what loads their direct permissions. */
async function chooseEmployee() {
  fireEvent.focus(screen.getByPlaceholderText('Search for an employee…'));
  fireEvent.mouseDown(await screen.findByRole('button', { name: /Alice Nguyen/ }));
  expect(await screen.findByText('door.manage')).toBeTruthy();
}

beforeEach(() => {
  vi.clearAllMocks();
  routeReads();
  caller.permissions = [];
});

describe('the Direct permissions tab, for an rbac.read holder', () => {
  beforeEach(() => {
    caller.permissions = ['rbac.read'];
  });

  it('still looks an employee up and shows why each grant exists', async () => {
    renderTab();
    await chooseEmployee();

    expect(screen.getByText('covering the front desk')).toBeTruthy();
  });

  it('offers neither Grant nor Revoke, because both need group.assign', async () => {
    renderTab();
    await chooseEmployee();

    expect(screen.queryByRole('button', { name: /grant a permission/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke permission' })).toBeNull();
  });

  it('does not treat rbac.manage as permission to grant', async () => {
    caller.permissions = ['rbac.read', 'rbac.manage'];
    renderTab();
    await chooseEmployee();

    expect(screen.queryByRole('button', { name: /grant a permission/i })).toBeNull();
  });
});

describe('the Direct permissions tab, for a group.assign holder', () => {
  beforeEach(() => {
    caller.permissions = ['rbac.read', 'group.assign'];
  });

  it('offers Grant and a Revoke on the row', async () => {
    renderTab();
    await chooseEmployee();

    expect(screen.getByRole('button', { name: /grant a permission/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke permission' })).toBeTruthy();
  });

  it('names what is missing instead of calling the API with an empty reason', async () => {
    renderTab();
    await chooseEmployee();
    fireEvent.click(screen.getByRole('button', { name: /grant a permission/i }));

    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/^Permission/), { target: { value: 'asset.read' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Grant' }));

    expect(await dialog.findByText(/say why this employee needs the permission/i)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
  });

  it('sends the grant globally, with its reason, for the chosen employee', async () => {
    POST.mockResolvedValue({ data: _GRANT });
    renderTab();
    await chooseEmployee();
    fireEvent.click(screen.getByRole('button', { name: /grant a permission/i }));

    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/^Permission/), { target: { value: 'asset.read' } });
    fireEvent.change(dialog.getByLabelText(/^Reason/), {
      target: { value: 'audit prep this week' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Grant' }));

    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith('/v1/authz/employee-permissions', {
      body: expect.objectContaining({
        employeeId: _EMPLOYEE.id,
        permissionKey: 'asset.read',
        scopeType: 'global',
        reason: 'audit prep this week',
      }) as unknown,
    });
  });

  it('reports a refused grant in the API’s words', async () => {
    POST.mockResolvedValue({
      error: {
        error: {
          code: 'FORBIDDEN',
          message: "Cannot grant 'asset.read': you do not hold it without a scope limit.",
        },
      },
    });
    renderTab();
    await chooseEmployee();
    fireEvent.click(screen.getByRole('button', { name: /grant a permission/i }));

    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/^Permission/), { target: { value: 'asset.read' } });
    fireEvent.change(dialog.getByLabelText(/^Reason/), {
      target: { value: 'audit prep this week' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Grant' }));

    expect(await dialog.findByText(/without a scope limit/)).toBeTruthy();
  });
});

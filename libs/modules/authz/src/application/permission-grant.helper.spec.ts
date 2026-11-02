import { describe, expect, it } from 'vitest';
import { mayGrantPermission } from './permission-grant.helper';

describe('mayGrantPermission', () => {
  it('allows a permission the grantor holds globally', () => {
    expect(mayGrantPermission({ 'asset.read': [{ type: 'global', id: null }] }, 'asset.read')).toBe(
      true,
    );
  });

  it('refuses a permission the grantor does not hold', () => {
    expect(
      mayGrantPermission({ 'asset.read': [{ type: 'global', id: null }] }, 'asset.write'),
    ).toBe(false);
  });

  it('refuses a permission held only inside a department', () => {
    expect(mayGrantPermission({ 'asset.read': [{ type: 'dept', id: 'QA' }] }, 'asset.read')).toBe(
      false,
    );
  });

  it('counts the `*` wildcard and a module-wide grant as holding what they cover', () => {
    expect(mayGrantPermission({ '*': [{ type: 'global', id: null }] }, 'door.manage')).toBe(true);
    expect(mayGrantPermission({ 'asset.*': [{ type: 'global', id: null }] }, 'asset.read')).toBe(
      true,
    );
    expect(mayGrantPermission({ 'asset.*': [{ type: 'global', id: null }] }, 'door.manage')).toBe(
      false,
    );
  });

  it('accepts a global grant even when a narrower one is also held', () => {
    expect(
      mayGrantPermission(
        {
          'asset.read': [
            { type: 'dept', id: 'QA' },
            { type: 'global', id: null },
          ],
        },
        'asset.read',
      ),
    ).toBe(true);
  });
});

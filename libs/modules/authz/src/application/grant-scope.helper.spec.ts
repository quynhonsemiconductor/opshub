import { describe, expect, it } from 'vitest';
import { resolveGrantScope } from './grant-scope.helper';

describe('resolveGrantScope', () => {
  it('defaults to a global scope with no scope id', () => {
    expect(resolveGrantScope(undefined, undefined)).toEqual({ scopeType: 'global', scopeId: null });
  });

  it('drops the scope id for global and self, which name no particular thing', () => {
    expect(resolveGrantScope('global', 'QA')).toEqual({ scopeType: 'global', scopeId: null });
    expect(resolveGrantScope('self', 'QA')).toEqual({ scopeType: 'self', scopeId: null });
  });

  it('keeps the department name for a dept scope', () => {
    expect(resolveGrantScope('dept', 'QA')).toEqual({ scopeType: 'dept', scopeId: 'QA' });
  });

  it('requires a scope id for a dept scope', () => {
    expect(() => resolveGrantScope('dept', null)).toThrow(/scopeId is required/);
  });

  it.each(['team', 'region'] as const)('refuses the unsupported %s scope', (scopeType) => {
    expect(() => resolveGrantScope(scopeType, 'anything')).toThrow(/not supported yet/);
  });
});

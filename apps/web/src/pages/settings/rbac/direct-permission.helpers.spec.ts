import { describe, expect, it } from 'vitest';
import {
  expiryInstantFromDate,
  isGrantExpired,
  validateGrantForm,
} from './direct-permission.helpers';

describe('validateGrantForm', () => {
  const complete = {
    employeeId: 'emp-1',
    permissionKey: 'door.manage',
    reason: 'covering the desk',
  };

  it('accepts a complete form', () => {
    expect(validateGrantForm(complete)).toBeNull();
  });

  it('names the first missing field', () => {
    expect(validateGrantForm({ ...complete, employeeId: '' })).toMatch(/employee/i);
    expect(validateGrantForm({ ...complete, permissionKey: '' })).toMatch(/permission/i);
  });

  it('refuses a reason that is blank or too short, however it is padded', () => {
    expect(validateGrantForm({ ...complete, reason: '   ' })).toMatch(/why/i);
    expect(validateGrantForm({ ...complete, reason: ' ab ' })).toMatch(/why/i);
  });
});

describe('expiryInstantFromDate', () => {
  it('is undefined for no date, so the grant never expires', () => {
    expect(expiryInstantFromDate('')).toBeUndefined();
  });

  it('is undefined for a date that is not real', () => {
    expect(expiryInstantFromDate('2026-13-45')).toBeUndefined();
  });

  it('ends the permission at the last second of the chosen day, in the reader’s timezone', () => {
    const instant = new Date(expiryInstantFromDate('2026-12-31')!);
    expect(instant.getHours()).toBe(23);
    expect(instant.getMinutes()).toBe(59);
    expect(instant.getSeconds()).toBe(59);
  });
});

describe('isGrantExpired', () => {
  const now = new Date('2026-11-02T12:00:00Z');

  it('never expires without an expiry', () => {
    expect(isGrantExpired(null, now)).toBe(false);
  });

  it('is expired once the expiry is not after now', () => {
    expect(isGrantExpired('2026-11-02T12:00:00Z', now)).toBe(true);
    expect(isGrantExpired('2026-11-01T00:00:00Z', now)).toBe(true);
  });

  it('is live before the expiry', () => {
    expect(isGrantExpired('2026-11-02T12:00:01Z', now)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { STAFF_EMAIL_DOMAINS, isStaffEmail } from './staff-domains';

describe('isStaffEmail', () => {
  it('is qnsc.vn, as decided with the owner', () => {
    expect(STAFF_EMAIL_DOMAINS).toEqual(['qnsc.vn']);
  });

  it.each(['jane@qnsc.vn', 'Jane.Doe@QNSC.VN', '  jane@qnsc.vn  '])('accepts %j', (email) => {
    expect(isStaffEmail(email)).toBe(true);
  });

  it.each([
    'jane@gmail.com',
    'jane@qnsc.vn.evil.example',
    'jane@evilqnsc.vn',
    'jane@sub.qnsc.vn',
    'jane@qnsc.vn@evil.example',
    'jane',
    '@qnsc.vn',
    '',
  ])('refuses %j', (email) => {
    expect(isStaffEmail(email)).toBe(false);
  });
});

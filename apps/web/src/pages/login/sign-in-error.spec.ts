import { describe, expect, it } from 'vitest';
import { signInErrorFrom } from './sign-in-error';

describe('signInErrorFrom', () => {
  it('has nothing to say when there is no error', () => {
    expect(signInErrorFrom('')).toBeNull();
    expect(signInErrorFrom('?returnTo=%2Fassets')).toBeNull();
  });

  it.each([
    ['BANNED_USER', /disabled/i],
    ['STAFF_SIGN_IN_REFUSED', /not signed in/i],
    ['unable_to_get_user_info', /company Microsoft account/i],
    ['ACCOUNT_LINK_REQUIRED', /another account/i],
  ])('explains %s and keeps the code to quote', (code, message) => {
    const error = signInErrorFrom(`?error=${code}`);
    expect(error?.code).toBe(code);
    expect(error?.message).toMatch(message);
  });

  it('shows an unknown code with a generic message', () => {
    expect(signInErrorFrom('?error=SOMETHING_NEW')).toEqual({
      code: 'SOMETHING_NEW',
      message: 'Sign in failed. Please try again or contact IT.',
    });
  });

  it('ignores a value that does not look like a code (it comes from the URL)', () => {
    expect(signInErrorFrom('?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E')).toBeNull();
    expect(signInErrorFrom(`?error=${'A'.repeat(65)}`)).toBeNull();
  });
});

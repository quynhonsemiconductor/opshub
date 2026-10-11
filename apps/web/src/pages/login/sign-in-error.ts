/**
 * What the login page says when identity sends the browser back with `?error=<CODE>`.
 *
 * Better Auth ends a refused sign-in with a redirect to `errorCallbackURL` carrying a stable code; without one
 * the browser lands on the API's own `/api/auth/error` page, which says nothing useful. The codes are the ones
 * identity and the product hook produce. The code is also shown, verbatim, so a person can quote it to IT.
 *
 * The code comes from the URL, so it is untrusted: it is only ever rendered as text, and only if it looks like
 * a code at all.
 */
const CODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

const MESSAGES: Record<string, string> = {
  BANNED_USER: 'This account has been disabled. Contact IT if you think this is a mistake.',
  STAFF_SIGN_IN_REFUSED:
    'You were not signed in. Your access could not be confirmed. Contact IT if this keeps happening.',
  unable_to_get_user_info:
    'Sign in with your company Microsoft account (an @qnsc.vn address in the company tenant). Guest and personal accounts are not accepted.',
  ACCOUNT_LINK_REQUIRED: 'This address already belongs to another account. Contact IT.',
};

export interface SignInError {
  code: string;
  message: string;
}

/** The error to show for a login URL's query string, or null when there is none worth showing. */
export function signInErrorFrom(search: string): SignInError | null {
  const code = new URLSearchParams(search).get('error');
  if (!code || !CODE_PATTERN.test(code)) return null;
  return {
    code,
    message: MESSAGES[code] ?? 'Sign in failed. Please try again or contact IT.',
  };
}

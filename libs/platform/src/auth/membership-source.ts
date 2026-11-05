/** Who put an employee in a group: a person, or the identity provider's sign-in sync. */
export const MEMBERSHIP_SOURCE = {
  /** Granted by a person through the admin API; only a person revokes it. */
  MANUAL: 'manual',
  /** Written by the sign-in reconcile from the id_token's App Roles; revoked when the token stops naming it. */
  IDP: 'idp',
} as const;

export type MembershipSource = (typeof MEMBERSHIP_SOURCE)[keyof typeof MEMBERSHIP_SOURCE];

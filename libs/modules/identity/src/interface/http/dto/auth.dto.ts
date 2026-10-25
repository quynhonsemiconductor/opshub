export class MeResponseDto {
  sub!: string;
  email!: string;
  name!: string;
  roles!: string[];
  /**
   * Effective permission keys resolved from the user's role assignments (DB).
   * `'*'` means super-admin (all permissions). This is the single source of
   * truth the SPA uses to gate UI — it must never re-derive permissions itself.
   */
  permissions!: string[];
  /**
   * Double-submit CSRF token, bound by HMAC to the session cookie that requested it. The SPA echoes it
   * in the `X-CSRF-Token` header on every state-changing request.
   *
   * Absent only for a request that carries no session cookie (there is nothing for a forged request to ride on).
   */
  csrfToken?: string;
}

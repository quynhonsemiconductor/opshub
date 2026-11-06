/**
 * The MCP access adapter: verifies the Cloudflare Access JWT (the `Cf-Access-Jwt-Assertion`
 * header the edge forwards to the origin; a direct client may also send that JWT itself as a
 * Bearer value) and maps the Entra identity to the opshub employee.
 *
 * This interface is the ONLY MCP code that touches authentication, and the principal is resolved
 * exactly once, per /mcp request. Everything downstream — the principal context, the guard, the
 * tools — already speaks employee ids. Swapping an implementation changes nothing else.
 */
export interface McpAccessPrincipal {
  /** The employee id (= identity user id). */
  userId: string;
  /** The employee's address, so self-scoped routes that echo the caller see the real value. */
  email: string;
  /** The employee's display name, same reason. */
  name: string;
}

export interface McpAccessVerifier {
  /**
   * Verifies the token value fully (signature, issuer, audience, window) and maps it to the
   * employee. Returns `null` when anything fails to verify — the caller answers one uniform 401.
   */
  verify(token: string): Promise<McpAccessPrincipal | null>;
}

/** Thrown when the route was booted without a real verifier. */
export class McpAccessNotConfiguredError extends Error {
  constructor() {
    super('MCP access verifier is not configured');
    this.name = 'McpAccessNotConfiguredError';
  }
}

export const UNCONFIGURED_MCP_ACCESS_VERIFIER: McpAccessVerifier = {
  verify: () => {
    throw new McpAccessNotConfiguredError();
  },
};

import { ValidationException, type ScopeType } from '@platform';

/**
 * Scope types that are in the `scope_type` enum but that nothing in the schema can satisfy.
 *
 * There is no teams table and no region column, so `ResourceScopeResolver` can never populate a team or a
 * region attribute and a grant scoped to either can only ever deny. Refusing at write time is the honest
 * failure: accepting the grant would let an operator believe they had scoped someone's access when they had
 * actually removed it. Re-allow a dimension here in the same change that gives the schema and the resolver
 * something to match on.
 */
const _UNSUPPORTED_SCOPE_TYPES: readonly ScopeType[] = ['team', 'region'];

/** Scope types that name no particular thing, so they store no scope id. */
const _SCOPE_TYPES_WITHOUT_SCOPE_ID: readonly ScopeType[] = ['global', 'self'];

/** The scope a grant is stored under. */
export interface ResolvedGrantScope {
  scopeType: ScopeType;
  scopeId: string | null;
}

/**
 * Resolves and validates the scope a group membership or a direct permission grant is stored under.
 *
 * Args:
 *   requestedScopeType: The scope type the caller asked for. Defaults to `global` when omitted.
 *   requestedScopeId: The scope identifier the caller supplied, such as a department name. Ignored for
 *     `global` and `self`, which name no particular thing.
 *
 * Returns:
 *   The scope type and the scope id to store; the id is null for `global` and `self`.
 *
 * Raises:
 *   ValidationException: If a scope id is required but missing, or the scope type is not supported yet.
 */
export function resolveGrantScope(
  requestedScopeType: ScopeType | undefined,
  requestedScopeId: string | null | undefined,
): ResolvedGrantScope {
  const scopeType = requestedScopeType ?? 'global';
  const scopeId = _SCOPE_TYPES_WITHOUT_SCOPE_ID.includes(scopeType)
    ? null
    : (requestedScopeId ?? null);

  if (!_SCOPE_TYPES_WITHOUT_SCOPE_ID.includes(scopeType) && !scopeId) {
    throw new ValidationException(
      'VALIDATION_FAILED',
      `scopeId is required for scope type '${scopeType}'`,
    );
  }

  if (_UNSUPPORTED_SCOPE_TYPES.includes(scopeType)) {
    throw new ValidationException(
      'VALIDATION_FAILED',
      `Scope type '${scopeType}' is not supported yet: no resource carries a ` +
        `${scopeType}, so the grant could never be satisfied. Use 'global', 'self' or 'dept'.`,
    );
  }

  return { scopeType, scopeId };
}

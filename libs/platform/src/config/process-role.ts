/**
 * Which process this is. NO IMPORTS, on purpose.
 *
 * The config module validates the environment when it is IMPORTED (`ConfigModule.forRoot` runs its
 * `validate` function immediately), so the role must be known before `@platform` is loaded. An entry point
 * therefore imports a tiny module that does nothing but call {@link setProcessRole} — `apps/api/src/role.ts`
 * and `apps/worker/src/role.ts` — as its first import after `load-env`. That module imports THIS file by
 * its path and nothing else, so nothing that validates the environment runs before it.
 */
export type ProcessRole = 'api' | 'worker';

let current: ProcessRole | undefined;

export function setProcessRole(role: ProcessRole): void {
  current = role;
}

export function getProcessRole(): ProcessRole | undefined {
  return current;
}

/** Test seam: forget the role, to exercise the "role not declared" refusal. */
export function resetProcessRoleForTests(): void {
  current = undefined;
}

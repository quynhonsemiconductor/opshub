/**
 * Every route the authenticated shell serves.
 *
 * KEPT IN LOCKSTEP WITH THE ROUTER by `src/test/route-coverage.ratchet.test.ts`, which reads both files and
 * fails if they disagree. A hand-maintained list that silently misses a new route is the same class of fault
 * as the bug this exists to catch: something is not covered and nothing says so.
 *
 * `/login` is deliberately absent — it is the one route that renders OUTSIDE the shell, so `gotoInShell`
 * cannot assert it and a signed-in visit redirects away.
 */
export const SHELL_ROUTES = [
  '/',
  '/access',
  '/assets',
  '/capas',
  '/catalog',
  '/compliance',
  '/contracts',
  '/controls',
  '/door',
  '/documents',
  '/finops',
  '/incidents',
  '/information-assets',
  '/internal-audits',
  '/management-reviews',
  '/nonconformances',
  '/people',
  '/performance',
  '/positions',
  '/profile',
  '/reports',
  '/requests',
  '/risks',
  '/security-posture',
  '/settings/access-control',
  '/settings/audit-logs',
  '/settings/notification-preferences',
  '/settings/webhooks',
  '/training',
  '/vendors',
  '/workforce',
] as const;

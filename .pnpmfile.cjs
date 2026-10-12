/**
 * pnpm install hooks.
 *
 * WHY THIS FILE EXISTS. `better-auth` (pulled in by `@quynhonsemiconductor/identity`) lists `drizzle-kit`,
 * `react`, `react-dom` and `vitest` as OPTIONAL peer dependencies: they serve its CLI, its React client and its
 * test helpers, and nothing at runtime. pnpm resolves an optional peer against whatever the importing project
 * has installed, and this project has all four (drizzle-kit and vitest as devDependencies, react through the
 * web app), so each one was written into better-auth's lockfile snapshot as an `optionalDependency`. A
 * `pnpm install --prod` follows optional dependencies, so the runtime image gained drizzle-kit, vitest and
 * their trees (esbuild with its Go binary, vite, rolldown ...) — the Trivy CRITICAL on esbuild's bundled Go
 * stdlib was the symptom, and a much larger attack surface the cause.
 *
 * Dropping those four peers from better-auth's manifest stops pnpm resolving them. Nothing is lost: the
 * features that use them (`auth generate`, `better-auth/react`, `better-auth/test`) are not used here, and
 * identity pins better-auth and runs its own conformance kit on every bump. `drizzle-orm` and `pg`, the peers
 * that ARE used, are untouched. `.pnpmfile.cjs` is copied into the Docker `deps` and `prod-deps` stages: a
 * frozen install checks this file's checksum against the lockfile.
 */
const DEV_ONLY_PEERS_OF_BETTER_AUTH = ['drizzle-kit', 'react', 'react-dom', 'vitest'];

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    for (const peer of DEV_ONLY_PEERS_OF_BETTER_AUTH) {
      delete pkg.peerDependencies?.[peer];
      delete pkg.peerDependenciesMeta?.[peer];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };

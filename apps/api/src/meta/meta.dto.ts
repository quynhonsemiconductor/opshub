/**
 * The running-version contract, shared by the SPA footer (`Web vX · API vY · env`).
 *
 * `version` is the image TAG the chart injects as `APP_VERSION`: `vX.Y.Z` on a release, `sha-<commit>`
 * on a dev build, and `dev` when nothing named one (a laptop, or a digest-only pin). `commit` is the
 * commit a `sha-<commit>` tag names, and `null` when the tag names none — a release tag is not a
 * commit, and inventing "dev" there would make the UI state something the deployment never said.
 */
export class MetaResponseDto {
  /** The API image tag, or `dev` when the deployment injected none. */
  version!: string;
  /** The commit behind a `sha-<commit>` tag; `null` for a release tag or an unknown tag. */
  commit!: string | null;
  /** The deployment environment (`dev` | `prod` …) from `DEPLOYMENT_ENV`; never `NODE_ENV`. */
  env!: string;
}

/**
 * The sidebar's running-version line: `v0.8.9 · prod`, or
 * `Web v0.8.9 · API v0.8.10 · dev` when the two images disagree.
 *
 * WHY BOTH ARE SHOWN WHEN THEY DIFFER. The bundle and the API are separate images promoted
 * independently, so a half-rolled deploy is a real state: the SPA a reader has open can be the
 * previous version while the API is the next one. One version number would hide which half moved;
 * naming each makes the split visible in the one place the owner asked for it.
 *
 * The web tag comes from `/config.json` (the chart renders it from the image tag); the API tag comes
 * from `GET /v1/meta`, which reads what the chart injected into the container. Neither is compiled
 * into the bundle, so neither can go stale against the image that is actually running.
 */
import { ENV } from '@/shared/config/env';
import { useApiMeta } from '@/shared/hooks/use-api-meta';
import { formatVersionLine, formatVersionTooltip } from './version-line';

export function VersionFooter() {
  const { data } = useApiMeta();
  const line = formatVersionLine(ENV.APP_VERSION, data?.version, data?.env);
  if (!line) return null;

  return (
    <p
      className="px-4 pb-3 text-2xs text-sidebar-label"
      title={formatVersionTooltip(ENV.APP_VERSION, ENV.APP_COMMIT, data)}
    >
      {line}
    </p>
  );
}

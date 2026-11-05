/**
 * The sidebar's running-version text, separate from the component so the rules are unit-testable
 * without rendering and the component file only exports a component (fast refresh).
 */

/** `v0.8.9 · prod`, or `Web v0.8.9 · API v0.8.10 · dev` when the two images disagree. */
export function formatVersionLine(
  web: string | undefined,
  api: string | undefined,
  env: string | undefined,
): string | null {
  const parts: string[] = [];
  if (web && api && web !== api) {
    parts.push(`Web ${web}`, `API ${api}`);
  } else if (web ?? api) {
    parts.push((web ?? api) as string);
  }
  if (env) parts.push(env);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** `Web v0.8.9 (abc1234) · API v0.8.9 (abc1234)`, for the hover. Only what is known. */
export function formatVersionTooltip(
  web: string | undefined,
  webCommit: string | undefined,
  api: { version: string; commit: string | null } | undefined,
): string | undefined {
  const parts: string[] = [];
  if (web) parts.push(`Web ${web}${webCommit ? ` (${webCommit})` : ''}`);
  if (api) parts.push(`API ${api.version}${api.commit ? ` (${api.commit})` : ''}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

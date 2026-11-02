/**
 * The on-prem edge contract (ONPREM-PLAN §8.2) — `apps/web/wrangler.jsonc` is half of it, and the
 * other half lives in another repo (`infra` `live/edge/onprem.tf`), so nothing else can catch drift.
 *
 * Each assertion protects a decision that fails SILENTLY when reversed:
 *
 * - the script names must be `<product>-<env>-web` — Terraform's `cloudflare_workers_route.spa`
 *   names its script that way, and a rename deploys a Worker no route points at (or, worse, leaves
 *   the routed name serving an old bundle forever);
 * - no `routes` in the config: `live/edge` owns routes and the deploy token is Workers Scripts:
 *   edit only. A route here either races Terraform or makes the deploy fail on a permission the
 *   token deliberately does not have;
 * - `workers_dev` / `preview_urls` off, at the TOP level and inside every environment (Wrangler does
 *   not inherit these), so the bundle has exactly one address: the host Access protects;
 * - SPA fallback, because every app route is client-side.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `wrangler.jsonc` is JSON + line comments; none of ours contain `//` inside a string value. */
function readConfig(): Record<string, unknown> {
  const raw = readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8');
  const json = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return JSON.parse(json) as Record<string, unknown>;
}

const config = readConfig();
const envs = config.env as Record<string, Record<string, unknown>>;

describe('the Workers Static Assets config', () => {
  it('names the two scripts Terraform routes to', () => {
    expect(envs.dev!.name).toBe('opshub-dev-web');
    expect(envs.prod!.name).toBe('opshub-prod-web');
  });

  it('declares no routes — live/edge owns them', () => {
    expect(config).not.toHaveProperty('routes');
    expect(config).not.toHaveProperty('route');
    for (const env of Object.values(envs)) {
      expect(env).not.toHaveProperty('routes');
      expect(env).not.toHaveProperty('route');
    }
  });

  it('turns workers.dev and preview URLs off everywhere, including each environment', () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    for (const env of Object.values(envs)) {
      expect(env.workers_dev).toBe(false);
      expect(env.preview_urls).toBe(false);
    }
  });

  it('serves the built SPA with client-side routing', () => {
    const assets = config.assets as Record<string, unknown>;
    expect(assets.directory).toBe('./dist');
    expect(assets.not_found_handling).toBe('single-page-application');
  });
});

import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '@platform';
import { MetaController } from './meta.controller';

/** A config that answers exactly the variables the chart injects. */
function controller(values: Record<string, string | undefined>): MetaController {
  return new MetaController({ get: (key: string) => values[key] } as AppConfigService);
}

describe('MetaController', () => {
  it('reports the image tag, the commit it names, and the deployment environment', () => {
    expect(
      controller({
        APP_VERSION: 'sha-0123456789ab',
        APP_COMMIT: '0123456789ab',
        DEPLOYMENT_ENV: 'dev',
      }).getMeta(),
    ).toEqual({ version: 'sha-0123456789ab', commit: '0123456789ab', env: 'dev' });
  });

  it('reports a release tag with no commit as null, never as "dev"', () => {
    // A release tag names bytes, not a commit. A false commit is worse than an absent one: the owner
    // reads this to answer "what is running", and "dev" is a value no release ever was.
    expect(controller({ APP_VERSION: 'v0.8.9', DEPLOYMENT_ENV: 'prod' }).getMeta()).toEqual({
      version: 'v0.8.9',
      commit: null,
      env: 'prod',
    });
  });

  it('falls back to "dev" and "development" when the deployment injected nothing', () => {
    // A laptop, a digest-only pin, or a chart older than 0.19.3. Still truthful: these are the
    // endpoint's defaults, not a guess at a version.
    expect(controller({}).getMeta()).toEqual({
      version: 'dev',
      commit: null,
      env: 'development',
    });
  });

  it('trims what the environment carries, and treats an empty value as absent', () => {
    expect(
      controller({ APP_VERSION: '  ', APP_COMMIT: '', DEPLOYMENT_ENV: ' prod ' }).getMeta(),
    ).toEqual({ version: 'dev', commit: null, env: 'prod' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_PATH, ConfigError, configSchema, loadConfig } from './config';
import { ENV } from './env';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID = { apiBaseUrl: '', appEnv: 'production', devLoginEnabled: false } as const;

beforeEach(() => {
  ENV.API_BASE_URL = '';
  ENV.APP_ENV = 'development';
  ENV.DEV_LOGIN_ENABLED = false;
});

describe('configSchema', () => {
  it('accepts the same-origin and path forms of apiBaseUrl', () => {
    for (const apiBaseUrl of ['', '/', '/api', '/v1']) {
      expect(configSchema.safeParse({ ...VALID, apiBaseUrl }).success).toBe(true);
    }
  });

  it('rejects an apiBaseUrl that leaves this origin', () => {
    for (const apiBaseUrl of [
      'api',
      '//evil.example.com',
      '/\\evil.example.com',
      'https://api.example.com',
      'http://localhost:3001',
      'ftp://example.com',
      ' localhost',
    ]) {
      expect(configSchema.safeParse({ ...VALID, apiBaseUrl }).success).toBe(false);
    }
  });

  it('rejects an unknown appEnv, a string boolean and a missing field', () => {
    expect(configSchema.safeParse({ ...VALID, appEnv: 'dev' }).success).toBe(false);
    expect(configSchema.safeParse({ ...VALID, devLoginEnabled: 'true' }).success).toBe(false);
    expect(configSchema.safeParse({ apiBaseUrl: '', appEnv: 'production' }).success).toBe(false);
  });
});

describe('loadConfig', () => {
  it('fetches /config.json without caching and applies it to ENV', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(VALID));

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).resolves.toEqual(VALID);

    expect(fetchImpl).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(ENV).toMatchObject({
      API_BASE_URL: '',
      APP_ENV: 'production',
      DEV_LOGIN_ENABLED: false,
    });
  });

  it('applies the dev login switch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...VALID, devLoginEnabled: true }));

    await loadConfig(fetchImpl as unknown as typeof fetch);

    expect(ENV.DEV_LOGIN_ENABLED).toBe(true);
  });

  it('fails with the status when the file is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow(ConfigError);
    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow('HTTP 404');
  });

  it('fails when the answer is not JSON (an SPA fallback page, for instance)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'is not valid JSON',
    );
  });

  it('fails with the field errors when the shape is wrong', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ apiBaseUrl: '', appEnv: 'dev', devLoginEnabled: false }));

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /is invalid:[\s\S]*appEnv/,
    );
    // Nothing was applied, so the app keeps its defaults rather than a half-read config.
    expect(ENV.APP_ENV).toBe('development');
  });

  it('fails when the request itself fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'Could not fetch /config.json: Failed to fetch',
    );
  });
});

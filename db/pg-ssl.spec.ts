import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgOptions, pgTls, tlsFromEnv } from './pg-ssl';

const URL_SSL = 'postgresql://u:p@db.internal:5432/rova?sslmode=require';
const CA = '-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----\\n';

function caFile(): string {
  const path = join(
    tmpdir(),
    `pg-ssl-spec-${process.pid}-${Math.random().toString(36).slice(2)}.pem`,
  );
  writeFileSync(path, CA);
  return path;
}

describe('pgTls', () => {
  it('verify-full with a CA: the file content is the only root, verification on', () => {
    expect(pgTls({ caFile: caFile() })).toEqual({ ca: CA, rejectUnauthorized: true });
  });

  it('fails closed in production with no CA', () => {
    expect(() => pgTls({ isProduction: true })).toThrow(/DATABASE_SSL_CA/);
  });

  it('an unreadable CA file is an error, not a downgrade', () => {
    expect(() => pgTls({ caFile: '/nonexistent/ca-bundle.pem' })).toThrow();
  });

  it('without a CA outside production it encrypts without verifying (local/CI compatibility)', () => {
    expect(pgTls({})).toEqual({ rejectUnauthorized: false });
  });
});

describe('pgOptions', () => {
  it('sslmode=disable stays plaintext even with a CA available', () => {
    const config = pgOptions('postgresql://u:p@localhost:5432/rova?sslmode=disable', {
      caFile: caFile(),
    });
    expect(config.ssl).toBeUndefined();
    expect(config.connectionString).toContain('sslmode=disable'); // left for pg to read
  });

  it('a URL without sslmode stays plaintext', () => {
    expect(pgOptions('postgresql://u:p@localhost:5432/rova').ssl).toBeUndefined();
  });

  it('with a CA it strips sslmode and hands pg explicit verify-full options', () => {
    const config = pgOptions(URL_SSL, { caFile: caFile() });
    expect(config.connectionString).toBe('postgresql://u:p@db.internal:5432/rova');
    expect(config.ssl).toMatchObject({ ca: CA, rejectUnauthorized: true });
  });

  it('no CA in production throws before any connection is attempted', () => {
    expect(() => pgOptions(URL_SSL, { isProduction: true })).toThrow(/DATABASE_SSL_CA/);
  });

  it('no CA outside production keeps the encrypted-unverified fallback', () => {
    const config = pgOptions(URL_SSL, {});
    expect(config.connectionString).toBe('postgresql://u:p@db.internal:5432/rova');
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });
});

describe('tlsFromEnv', () => {
  it('reads the two variables and treats NODE_ENV=production as production', () => {
    expect(tlsFromEnv({ DATABASE_SSL_CA: '/etc/ssl/bundle.pem', NODE_ENV: 'production' })).toEqual({
      caFile: '/etc/ssl/bundle.pem',
      isProduction: true,
    });
    expect(tlsFromEnv({ NODE_ENV: 'development' })).toEqual({
      caFile: undefined,
      isProduction: false,
    });
  });
});

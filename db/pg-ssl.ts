/**
 * TLS for every node-postgres connection (pool, migrator, scripts).
 *
 * `sslmode=require` in the URL means "encrypt". pg-connection-string v3 maps it
 * to rejectUnauthorized=true — verify-full — which fails on Alpine (no Amazon
 * RDS CA in the system store). We strip sslmode and pass an explicit `ssl`
 * object instead, so the verification level is decided HERE, not by the
 * connection-string parser:
 *
 * - `DATABASE_SSL_CA` set  → the file is trusted as the only root and the
 *   certificate chain AND hostname are verified (verify-full). On AWS this is
 *   the RDS global bundle (baked into the image at
 *   /etc/ssl/rds-global-bundle.pem); on-prem it is the mounted CNPG `ca.crt`.
 * - no CA, NODE_ENV=production → boot ERROR. Production never encrypts without
 *   verifying: a silent `rejectUnauthorized:false` fallback would turn any
 *   missed wiring into traffic a man-in-the-middle can read.
 * - no CA, otherwise (local dev, CI) → encrypt, skip verification. The
 *   pre-existing behaviour, kept so local stacks and CI (sslmode=disable
 *   anyway) are untouched.
 *
 * `sslmode=disable` in the URL is honoured as plaintext whatever the CA says.
 */
import { readFileSync } from 'node:fs';

export interface PgTlsInput {
  /** Path to the CA bundle the server certificate must chain to. */
  caFile?: string;
  /** Deployed environments run NODE_ENV=production. */
  isProduction?: boolean;
}

export interface PgTls {
  ca?: string;
  rejectUnauthorized: boolean;
}

export function pgOptions(
  url: string,
  // DEFAULTS TO tlsFromEnv() ON PURPOSE: a call site that adds a new pool and
  // forgets the TLS argument still reads DATABASE_SSL_CA / NODE_ENV from the real
  // environment and fails closed in production, instead of silently falling back
  // to encrypted-unverified. Callers with a config service pass it explicitly.
  tls: PgTlsInput = tlsFromEnv(),
): { connectionString: string; ssl?: PgTls } {
  const needsSsl = /sslmode=(require|verify)/.test(url);
  if (!needsSsl) return { connectionString: url };
  return { connectionString: stripSslmode(url), ssl: pgTls(tls) };
}

/** Fail-closed TLS decision, shared by pgOptions and any non-pg consumer that needs the same rule. */
export function pgTls({ caFile, isProduction = false }: PgTlsInput = {}): PgTls {
  if (caFile) {
    return { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  }
  if (isProduction) {
    throw new Error(
      'DATABASE_SSL_CA is required in production: refusing a database connection that is ' +
        'encrypted without being verified. Set it to a CA bundle file (RDS global bundle in the ' +
        'image, or the CNPG ca.crt on-prem), or run with NODE_ENV != production for local work.',
    );
  }
  return { rejectUnauthorized: false };
}

function stripSslmode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url;
  }
}

/** The TLS input from a raw env bag, for the standalone db scripts (migrate, seed, roles, backfills). */
export function tlsFromEnv(env: NodeJS.ProcessEnv = process.env): PgTlsInput {
  return { caFile: env.DATABASE_SSL_CA, isProduction: env.NODE_ENV === 'production' };
}

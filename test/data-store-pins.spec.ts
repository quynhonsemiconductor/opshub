/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * The local compose stack and every CI service container run the same PostgreSQL and Valkey images. One
 * version per engine: a bump lands in every place at once or fails here. Terraform's engine_version joins
 * this check in the infra PR that upgrades develop.
 *
 * The check parses the YAML, so quoting, trailing comments and indentation do not matter. Image names are
 * compared after dropping a `docker.io/` or `docker.io/library/` prefix, so the same image written either way
 * counts as the same image.
 */
const ROOT = join(__dirname, '..');

/** Every `image:` value in a parsed YAML document, at any depth. */
function imagesIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(imagesIn);
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) =>
      key === 'image' && typeof value === 'string' ? [normalise(value)] : imagesIn(value),
    );
  }
  return [];
}

function normalise(image: string): string {
  return image.replace(/^docker\.io\/(library\/)?/, '').trim();
}

const engines = {
  postgres: /^postgres:/,
  valkey: /^valkey\/valkey:/,
} as const;

const composeImages = imagesIn(
  parseYaml(readFileSync(join(ROOT, 'docker-compose.dev.yml'), 'utf8')),
);
const workflowDir = join(ROOT, '.github/workflows');
const ciImages = readdirSync(workflowDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .flatMap((file) => imagesIn(parseYaml(readFileSync(join(workflowDir, file), 'utf8'))));

describe('data-store image pins', () => {
  it('PostgreSQL is the Debian image of one exact 18.x release (glibc collation, as on RDS)', () => {
    const pinned = composeImages.filter((image) => engines.postgres.test(image));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatch(/^postgres:18\.\d+$/);
  });

  it('Valkey is one exact 8.1 alpine release', () => {
    const pinned = composeImages.filter((image) => engines.valkey.test(image));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatch(/^valkey\/valkey:8\.1\.\d+-alpine$/);
  });

  it.each(Object.keys(engines) as (keyof typeof engines)[])(
    '%s in every CI service container equals the compose pin, and CI runs at least one of them',
    (engine) => {
      const pinned = composeImages.find((image) => engines[engine].test(image));
      const inCi = ciImages.filter((image) => engines[engine].test(image));
      expect(inCi.length).toBeGreaterThan(0);
      for (const image of inCi) expect(image).toBe(pinned);
    },
  );
  it('develop RDS major equals the compose PostgreSQL major', () => {
    const terraform = readFileSync(join(ROOT, 'infra/live/develop/main.tf'), 'utf8');
    const developMajor = terraform.match(/rds = \{[\s\S]*?engine_version\s*=\s*"(\d+)(?:\.\d+)?"/)?.[1];
    const composeMajor = composeImages
      .find((image) => engines.postgres.test(image))
      ?.match(/^postgres:(\d+)\./)?.[1];
    expect(developMajor).toBeDefined();
    expect(developMajor).toBe(composeMajor);
  });
});

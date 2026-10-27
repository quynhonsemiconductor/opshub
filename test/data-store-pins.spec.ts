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

/** A CI service image is either `repo:tag` or `repo:tag@sha256:<64 hex>` — nothing else. */
const CI_IMAGE_RE = /^(?<tag>[^@]+)(?<digest>@sha256:(?<hex>[a-f0-9]{64}))?$/;

/** Parse a CI image, throwing on anything the regex rejects (typo'd digest, second @, ...). */
function parseCiImage(image: string): { tag: string; digest: string | null } {
  const match = CI_IMAGE_RE.exec(image);
  if (!match?.groups) throw new Error(`malformed CI service image: ${image}`);
  return { tag: match.groups.tag, digest: match.groups.hex ?? null };
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
      const parsed = inCi.map(parseCiImage);
      // Every CI image is the compose tag, digest-pinned (a bare tag floats and
      // would silently change bytes between runs), and one tag never resolves at
      // two digests.
      const digests = parsed.map((image) => {
        expect(image.tag).toBe(pinned);
        expect(image.digest, `${image.tag} is not digest-pinned`).toMatch(/^[a-f0-9]{64}$/);
        return image.digest as string;
      });
      expect(new Set(digests).size).toBe(1);
    },
  );
});

/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The local compose stack and every CI service container run the same PostgreSQL and Valkey images. One
 * version per engine: a bump lands in every place at once or fails here. Terraform's engine_version joins
 * this check in the infra PR that upgrades develop.
 */
const ROOT = join(__dirname, '..');

function images(text: string, name: RegExp): string[] {
  return [...text.matchAll(/^\s*image:\s*(\S+)\s*$/gm)]
    .map((m) => m[1])
    .filter((image) => name.test(image));
}

const compose = readFileSync(join(ROOT, 'docker-compose.dev.yml'), 'utf8');
const workflowDir = join(ROOT, '.github/workflows');
const workflows = readdirSync(workflowDir)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => ({ file, text: readFileSync(join(workflowDir, file), 'utf8') }));

describe('data-store image pins', () => {
  it.each([
    ['postgres', /^postgres:/],
    ['valkey', /^valkey\/valkey:/],
  ])('%s is one exact version in compose and in every CI workflow', (_engine, pattern) => {
    const pinned = images(compose, pattern);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatch(/-alpine$/);
    for (const { file, text } of workflows) {
      for (const image of images(text, pattern)) {
        expect({ file, image }).toEqual({ file, image: pinned[0] });
      }
    }
  });
});
